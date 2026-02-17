import { JWTTokenFactory } from '../jwt/jwt-token-factory.js'
import { CertificateManager, SignCSRRequestSchema } from '@catalyst/pki'
import {
  ALL_POLICIES,
  AuthorizationEngine,
  CATALYST_SCHEMA,
  type CatalystPolicyDomain,
  Principal,
} from '../policy/src/index.js'
import { CatalystService, type CatalystServiceOptions } from '@catalyst/service'
import { Hono } from 'hono'
import { AuthRpcServer, createAuthRpcHandler } from './rpc/server.js'

export class AuthService extends CatalystService {
  readonly info = { name: 'auth', version: '0.0.0' }
  readonly handler = new Hono()

  private _tokenFactory!: JWTTokenFactory
  private _rpcServer!: AuthRpcServer
  private _systemToken!: string
  private _certificateManager?: CertificateManager

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

  get certificateManager(): CertificateManager | undefined {
    return this._certificateManager
  }

  protected async onInitialize(): Promise<void> {
    const logger = this.telemetry.logger

    // Initialize JWT token factory (wires key + token persistence)
    this._tokenFactory = new JWTTokenFactory({
      local: {
        keyDbFile: this.config.auth?.keysDb,
        tokenDbFile: this.config.auth?.tokensDb,
        nodeId: this.config.node.name,
      },
    })
    await this._tokenFactory.initialize()

    void logger.info`JWTTokenFactory initialized`

    // Initialize PKI Certificate Manager via config-driven factory
    const pkiConfig = this.config.auth?.pki
    this._certificateManager = pkiConfig
      ? CertificateManager.fromConfig(pkiConfig)
      : CertificateManager.ephemeral()
    const pkiResult = await this._certificateManager.initialize()
    void logger.info`PKI initialized — root: ${pkiResult.rootFingerprint}, services: ${pkiResult.servicesCaFingerprint}, transport: ${pkiResult.transportCaFingerprint}`

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

    // Build RPC server with CertificateManager
    this._rpcServer = new AuthRpcServer(
      this._tokenFactory,
      this.telemetry,
      policyService,
      this.config.node.name,
      this.config.node.domains[0] || '',
      this._certificateManager
    )
    this._rpcServer.setSystemToken(this._systemToken)

    // Mount routes
    this.handler.get('/.well-known/jwks.json', async (c) => {
      const jwks = await this._tokenFactory.getJwks()
      c.header('Cache-Control', 'public, max-age=300')
      return c.json(jwks)
    })
    this.handler.route('/rpc', createAuthRpcHandler(this._rpcServer))

    // Mount PKI HTTP endpoints
    if (this._certificateManager) {
      // Public: CA bundle (no auth — read-only trust anchor distribution)
      this.handler.get('/pki/ca/bundle', async (c) => {
        try {
          const bundle = await this._certificateManager!.getCaBundle()
          const etag = `"${bundle.version}"`
          if (c.req.header('If-None-Match') === etag) {
            return c.body(null, 304)
          }
          c.header('ETag', etag)
          c.header('Cache-Control', 'public, max-age=300')
          return c.json(bundle)
        } catch {
          return c.json({ error: 'CA not initialized' }, 503)
        }
      })

      // Authenticated: CSR signing
      this.handler.post('/pki/csr/sign', async (c) => {
        const authHeader = c.req.header('Authorization')
        if (!authHeader?.startsWith('Bearer ')) {
          return c.json({ error: 'Missing authorization' }, 401)
        }
        const token = authHeader.slice(7)
        const auth = await this._tokenFactory.verify(token)
        if (!auth.valid) {
          return c.json({ error: 'Invalid token' }, 401)
        }

        const body = await c.req.json()
        const parsed = SignCSRRequestSchema.safeParse(body)
        if (!parsed.success) {
          return c.json({ error: parsed.error.message }, 400)
        }

        try {
          const result = await this._certificateManager!.signCSR(parsed.data)
          return c.json(result)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          if (message.startsWith('Identity denied')) {
            return c.json({ error: message }, 403)
          }
          return c.json({ error: message }, 500)
        }
      })
    }
  }

  protected async onShutdown(): Promise<void> {
    await this._tokenFactory.shutdown()
    await this._certificateManager?.shutdown()
  }
}
