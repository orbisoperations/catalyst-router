import { JWTTokenFactory } from '../jwt/jwt-token-factory.js'
import {
  Action,
  ALL_POLICIES,
  AuthorizationEngine,
  CATALYST_SCHEMA,
  type CatalystPolicyDomain,
  Principal,
  Role,
} from '../policy/src/index.js'
import { EntityBuilderFactory } from '../policy/src/entity-builder.js'
import { CatalystService, type CatalystServiceOptions } from '@catalyst/service'
import { Hono } from 'hono'
import { AuthRpcServer, createAuthRpcHandler } from './rpc/server.js'

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
const REFRESH_THRESHOLD = 0.8
const REFRESH_CHECK_INTERVAL = 60 * 60 * 1000 // 1 hour

export class AuthService extends CatalystService {
  readonly info = { name: 'auth', version: '0.0.0' }
  readonly handler = new Hono()

  private _tokenFactory!: JWTTokenFactory
  private _rpcServer!: AuthRpcServer
  private _systemToken!: string
  private _otelToken = ''
  private _otelTokenExpiresAt = 0
  private _refreshInterval: ReturnType<typeof setInterval> | undefined

  constructor(options: CatalystServiceOptions) {
    super(options)
  }

  get tokenFactory(): JWTTokenFactory {
    return this._tokenFactory
  }

  get rpcServer(): AuthRpcServer {
    return this._rpcServer
  }

  get systemToken(): string {
    return this._systemToken
  }

  get otelToken(): string {
    return this._otelToken
  }

  protected async onInitialize(): Promise<void> {
    const logger = this.telemetry.logger
    const issuer = process.env.CATALYST_AUTH_ISSUER

    // Initialize JWT token factory (wires key + token persistence)
    this._tokenFactory = new JWTTokenFactory({
      local: {
        keyDbFile: this.config.auth?.keysDb,
        tokenDbFile: this.config.auth?.tokensDb,
        nodeId: this.config.node.name,
        issuer,
      },
    })
    await this._tokenFactory.initialize()

    void logger.info`JWTTokenFactory initialized`

    // Initialize the policy authorization engine using the standard Catalyst domain
    const policyService = new AuthorizationEngine<CatalystPolicyDomain>(
      CATALYST_SCHEMA,
      ALL_POLICIES
    )
    const validationResult = policyService.validatePolicies()
    if (!validationResult) {
      void logger.error`Invalid policies - policy validation failed`
      process.exit(1)
    }

    // Mint system admin token
    this._systemToken = await this._tokenFactory.mint({
      subject: 'bootstrap',
      entity: {
        id: 'system',
        name: 'System Admin',
        type: 'service',
        trustedDomains: this.config.node.domains,
        trustedNodes: [],
      },
      principal: Principal.ADMIN,
      expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
    })

    void logger.info`System Admin Token minted: ${this._systemToken}`

    // -- Telemetry token minting with Cedar policy evaluation --
    const entityFactory = new EntityBuilderFactory<CatalystPolicyDomain>()
    entityFactory
      .registerMapper('CATALYST::TELEMETRY_EXPORTER', (data: Record<string, unknown>) => ({
        id: data.id as string,
        attrs: data,
      }))
      .registerMapper('CATALYST::ADMIN', (data: Record<string, unknown>) => ({
        id: data.id as string,
        attrs: data,
      }))
      .registerMapper('CATALYST::Collector', (data: Record<string, unknown>) => ({
        id: data.id as string,
        attrs: { nodeId: data.nodeId, domainId: data.domainId },
      }))

    const mintTelemetryToken = async (): Promise<{ token: string; expiresAt: number } | null> => {
      const builder = entityFactory.createEntityBuilder()
      builder.add('CATALYST::TELEMETRY_EXPORTER', {
        id: 'telemetry-exporter',
        name: 'Telemetry Exporter',
        type: 'service',
        role: 'TELEMETRY_EXPORTER',
        trustedNodes: [],
        trustedDomains: this.config.node.domains,
      })
      builder.add('CATALYST::Collector', {
        id: 'collector',
        nodeId: this.config.node.name,
        domainId: this.config.node.domains[0] || '',
      })
      const entities = builder.build()

      const result = policyService.isAuthorized({
        principal: entities.entityRef('CATALYST::TELEMETRY_EXPORTER', 'telemetry-exporter'),
        action: `CATALYST::Action::${Action.TELEMETRY_EXPORT}`,
        resource: entities.entityRef('CATALYST::Collector', 'collector'),
        entities: entities.getAll(),
        context: {},
      })

      if (result.type !== 'evaluated' || result.decision !== 'allow') {
        void logger.warn`Cedar policy denied TELEMETRY_EXPORT action`
        return null
      }

      const expiresAt = Date.now() + TOKEN_TTL_MS
      const token = await this._tokenFactory.mint({
        subject: 'telemetry-exporter',
        audience: 'otel-collector',
        entity: {
          id: 'telemetry-exporter',
          name: 'Telemetry Exporter',
          type: 'service',
          trustedDomains: this.config.node.domains,
          trustedNodes: [],
        },
        principal: Principal.TELEMETRY_EXPORTER,
        expiresAt,
      })

      return { token, expiresAt }
    }

    // Mint initial telemetry token
    const initialTelemetry = await mintTelemetryToken()
    if (initialTelemetry) {
      this._otelToken = initialTelemetry.token
      this._otelTokenExpiresAt = initialTelemetry.expiresAt
      void logger.info`Telemetry exporter token minted`
    } else {
      void logger.warn`Telemetry token not minted — Cedar policy denied`
    }

    // Self-refresh interval
    this._refreshInterval = setInterval(async () => {
      try {
        const now = Date.now()
        const tokenAge = now - (this._otelTokenExpiresAt - TOKEN_TTL_MS)
        if (tokenAge >= TOKEN_TTL_MS * REFRESH_THRESHOLD) {
          const refreshed = await mintTelemetryToken()
          if (refreshed) {
            this._otelToken = refreshed.token
            this._otelTokenExpiresAt = refreshed.expiresAt
            void logger.info`Telemetry token refreshed`
          }
        }
      } catch (err) {
        void logger.error`Telemetry token refresh failed: ${err}`
      }
    }, REFRESH_CHECK_INTERVAL)

    // Build RPC server
    this._rpcServer = new AuthRpcServer(
      this._tokenFactory,
      this.telemetry,
      policyService,
      this.config.node.name,
      this.config.node.domains[0] || ''
    )
    this._rpcServer.setSystemToken(this._systemToken)

    // Mount routes
    this.handler.get('/.well-known/openid-configuration', (c) => {
      return c.json({
        issuer: issuer,
        jwks_uri: `${issuer}/.well-known/jwks.json`,
        response_types_supported: ['id_token'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['ES384'],
      })
    })
    this.handler.get('/.well-known/jwks.json', async (c) => {
      const jwks = await this._tokenFactory.getJwks()
      c.header('Cache-Control', 'public, max-age=300')
      return c.json(jwks)
    })
    this.handler.get('/telemetry/token', async (c) => {
      // Verify bearer token
      const authHeader = c.req.header('Authorization')
      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Invalid or missing authorization token' }, 401)
      }
      const bearerToken = authHeader.slice(7)
      const verification = await this._tokenFactory.verify(bearerToken)
      if (!verification.valid) {
        return c.json({ error: 'Invalid or missing authorization token' }, 401)
      }

      // Re-evaluate Cedar policy on every request
      const freshToken = await mintTelemetryToken()
      if (!freshToken) {
        return c.json(
          { error: 'Permission denied: TELEMETRY_EXPORT action not permitted by policy' },
          403
        )
      }

      // Return cached token if still valid, otherwise use fresh
      if (this._otelToken && this._otelTokenExpiresAt > Date.now()) {
        return c.json({
          token: this._otelToken,
          expiresAt: new Date(this._otelTokenExpiresAt).toISOString(),
        })
      }

      this._otelToken = freshToken.token
      this._otelTokenExpiresAt = freshToken.expiresAt
      return c.json({
        token: freshToken.token,
        expiresAt: new Date(freshToken.expiresAt).toISOString(),
      })
    })
    this.handler.route('/rpc', createAuthRpcHandler(this._rpcServer))
  }

  protected async onShutdown(): Promise<void> {
    if (this._refreshInterval) {
      clearInterval(this._refreshInterval)
      this._refreshInterval = undefined
    }
    await this._tokenFactory.shutdown()
  }
}
