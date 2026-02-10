import {
  ALL_POLICIES,
  AuthorizationEngine,
  CATALYST_SCHEMA,
  type CatalystPolicyDomain,
  JWTTokenFactory,
  Role,
} from '@catalyst/authorization'
import { CatalystService, type CatalystServiceOptions } from '@catalyst/service'
import { Hono } from 'hono'
import { ApiKeyService } from './api-key-service.js'
import { BootstrapService } from './bootstrap.js'
import { LoginService } from './login.js'
import { hashPassword } from './password.js'
import { AuthRpcServer, createAuthRpcHandler } from './rpc/server.js'
import {
  InMemoryBootstrapStore,
  InMemoryServiceAccountStore,
  InMemoryUserStore,
} from './stores/memory.js'

export class AuthService extends CatalystService {
  readonly info = { name: 'auth', version: '0.0.0' }
  readonly handler = new Hono()

  private _tokenFactory!: JWTTokenFactory
  private _rpcServer!: AuthRpcServer
  private _systemToken!: string

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
        role: Role.ADMIN,
        trustedDomains: this.config.node.domains,
        trustedNodes: [],
      },
      roles: [Role.ADMIN],
      expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
    })

    void logger.info`System Admin Token minted: ${this._systemToken}`

    // Initialize stores
    const userStore = new InMemoryUserStore()
    const serviceAccountStore = new InMemoryServiceAccountStore()
    const bootstrapStore = new InMemoryBootstrapStore()

    // Initialize services
    const bootstrapService = new BootstrapService(userStore, bootstrapStore)
    const loginService = new LoginService(userStore, this._tokenFactory.getTokenManager())
    const apiKeyService = new ApiKeyService(serviceAccountStore)

    // Initialize bootstrap with env token or generate new one
    const envBootstrapToken = this.config.auth?.bootstrap?.token
    const bootstrapTtl = this.config.auth?.bootstrap?.ttl || 24 * 60 * 60 * 1000

    if (envBootstrapToken) {
      const tokenHash = await hashPassword(envBootstrapToken)
      const expiresAt = new Date(Date.now() + bootstrapTtl)
      await bootstrapStore.set({ tokenHash, expiresAt, used: false })
      void logger.info`Bootstrap initialized from config, expires at ${expiresAt.toISOString()}`
    } else {
      const result = await bootstrapService.initializeBootstrap({ expiresInMs: bootstrapTtl })
      void logger.info`Bootstrap token generated: ${result.token}, expires at ${result.expiresAt.toISOString()}`
    }

    // Build RPC server
    this._rpcServer = new AuthRpcServer(
      this._tokenFactory,
      bootstrapService,
      loginService,
      apiKeyService,
      policyService,
      this.config.node.name,
      this.config.node.domains[0] || ''
    )
    this._rpcServer.setSystemToken(this._systemToken)

    // Mount routes
    this.handler.get('/.well-known/jwks.json', async (c) => {
      const jwks = await this._tokenFactory.getJwks()
      c.header('Cache-Control', 'public, max-age=300')
      return c.json(jwks)
    })
    this.handler.route('/rpc', createAuthRpcHandler(this._rpcServer))
  }

  protected async onShutdown(): Promise<void> {
    await this._tokenFactory.shutdown()
  }
}
