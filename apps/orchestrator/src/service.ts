import { newRpcResponse } from '@hono/capnweb'
import { newWebSocketRpcSession } from 'capnweb'
import { Principal } from '@catalyst/authorization'
import { Actions } from '@catalyst/routing'
import { CatalystService } from '@catalyst/service'
import type { CatalystServiceOptions } from '@catalyst/service'
import { Hono } from 'hono'
import { upgradeWebSocket } from '@catalyst/service'
import { CatalystNodeBus } from './orchestrator.js'
import * as x509 from '@peculiar/x509'

// Ensure @peculiar/x509 uses Bun's crypto
x509.cryptoProvider.set(crypto)

/**
 * PKI RPC handlers returned by AuthRpcApi.pki(token).
 */
interface PkiRpcHandlers {
  signCsr(request: {
    csrPem: string
    serviceType: string
    instanceId: string
    ttlSeconds?: number
  }): Promise<
    | {
        success: true
        certificatePem: string
        chain: string[]
        expiresAt: string
        renewAfter: string
        fingerprint: string
        serial: string
      }
    | { success: false; error: string }
  >
  getCaBundle(): Promise<{
    trustDomain: string
    servicesBundle: string[]
    transportBundle: string[]
    version: string
    expiresAt: string
  }>
}

/**
 * Auth Service RPC API for token minting and PKI operations.
 */
interface AuthRpcApi {
  tokens(token: string): Promise<
    | {
        create(request: {
          subject: string
          entity: {
            id: string
            name: string
            type: 'user' | 'service'
            nodeId?: string
            trustedNodes?: string[]
            trustedDomains?: string[]
          }
          principal: string
          sans?: string[]
          expiresIn?: string
        }): Promise<string>
        revoke(request: { jti?: string; san?: string }): Promise<void>
        list(request: { certificateFingerprint?: string; san?: string }): Promise<unknown[]>
      }
    | { error: string }
  >
  pki(token: string): Promise<PkiRpcHandlers | { error: string }>
}

/** TLS configuration for Envoy proxy. */
export interface EnvoyTlsConfig {
  certChain: string
  privateKey: string
  caBundle: string
  requireClientCert?: boolean
  ecdhCurves?: string[]
}

// Token refresh threshold: refresh when 80% of TTL has elapsed
const REFRESH_THRESHOLD = 0.8
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days in milliseconds
const REFRESH_CHECK_INTERVAL = 60 * 60 * 1000 // 1 hour

// SVID certificate constants
const EC_ALGORITHM: EcKeyGenParams = { name: 'ECDSA', namedCurve: 'P-384' }
const SIGNING_ALGORITHM: EcdsaParams = { name: 'ECDSA', hash: 'SHA-384' }
const CERT_RENEW_CHECK_INTERVAL = 5 * 60 * 1000 // 5 minutes

export class OrchestratorService extends CatalystService {
  readonly info = { name: 'orchestrator', version: '0.0.0' }
  readonly handler = new Hono()

  private _bus!: CatalystNodeBus
  private _nodeToken: string | undefined
  private _tokenIssuedAt: Date | undefined
  private _tokenExpiresAt: Date | undefined
  private _refreshInterval: ReturnType<typeof setInterval> | undefined
  private _tlsConfig: EnvoyTlsConfig | undefined
  private _certRenewAt: Date | undefined
  private _certRenewInterval: ReturnType<typeof setInterval> | undefined

  constructor(options: CatalystServiceOptions) {
    super(options)
  }

  get bus(): CatalystNodeBus {
    return this._bus
  }

  protected async onInitialize(): Promise<void> {
    // Mint node token if auth is configured
    await this.mintNodeToken()

    // Request SVID certificate for TLS (non-fatal if unavailable)
    await this.requestNodeCertificate()

    // Set up periodic token refresh
    if (this.config.orchestrator?.auth) {
      this._refreshInterval = setInterval(
        () => this.refreshNodeTokenIfNeeded(),
        REFRESH_CHECK_INTERVAL
      )
      this.telemetry.logger.info`Token refresh check enabled (every hour)`

      // Set up SVID certificate renewal
      if (this._tlsConfig) {
        this.setupCertRenewal()
        this.telemetry.logger.info`SVID cert renewal check enabled (every 5 min)`
      }
    }

    // Build the CatalystNodeBus
    this._bus = new CatalystNodeBus({
      config: this.config.orchestrator
        ? {
            ...this.config.orchestrator,
            node: {
              ...this.config.node,
              endpoint: this.config.node.endpoint!, // Orchestrator requires an endpoint
            },
          }
        : {
            node: {
              ...this.config.node,
              endpoint: this.config.node.endpoint!,
            },
          },
      connectionPool: { type: 'ws' },
      nodeToken: this._nodeToken,
      authEndpoint: this.config.orchestrator?.auth?.endpoint,
      tlsConfig: this._tlsConfig,
    })

    // Mount RPC route
    this.handler.all('/rpc', (c) => {
      return newRpcResponse(c, this._bus.publicApi(), {
        upgradeWebSocket,
      })
    })

    // Register core services as data channels so they are fronted by Envoy
    // with PQ mTLS when a publicAddress is configured. These routes propagate
    // to peers via iBGP, enabling cross-node access through Envoy.
    await this.registerCoreDataChannels()

    this.telemetry.logger.info`Orchestrator running as ${this.config.node.name}`
  }

  protected async onShutdown(): Promise<void> {
    if (this._refreshInterval) {
      clearInterval(this._refreshInterval)
      this._refreshInterval = undefined
    }
    if (this._certRenewInterval) {
      clearInterval(this._certRenewInterval)
      this._certRenewInterval = undefined
    }
  }

  /**
   * Register core services (orchestrator, auth) as local data channels.
   *
   * When the node has a `publicAddress`, these data channels are fronted by
   * Envoy ingress listeners with PQ mTLS. Remote peers discover them via
   * iBGP route advertisements and connect through Envoy.
   *
   * Without `publicAddress`, the routes still exist for Envoy port allocation
   * but are only reachable on the local/stack-control network.
   */
  private async registerCoreDataChannels(): Promise<void> {
    if (!this.config.orchestrator?.envoyConfig) {
      this.telemetry.logger.info`No envoy config -- skipping core data channel registration`
      return
    }

    // Register orchestrator-rpc: the iBGP peering endpoint
    const orchEndpoint = this.config.node.endpoint!.replace(/^ws(s?):/, 'http$1:')
    const orchResult = await this._bus.dispatch({
      action: Actions.LocalRouteCreate,
      data: {
        name: 'orchestrator-rpc',
        endpoint: orchEndpoint,
        protocol: 'http' as const,
      },
    })
    if (orchResult.success) {
      this.telemetry.logger.info`Registered core data channel: orchestrator-rpc → ${orchEndpoint}`
    } else {
      this.telemetry.logger
        .warn`Failed to register orchestrator-rpc: ${'error' in orchResult ? orchResult.error : 'unknown'}`
    }

    // Wait for any side-effects (Envoy config push) to complete
    if (this._bus.lastNotificationPromise) {
      await this._bus.lastNotificationPromise
    }

    // Register auth-rpc if auth is configured
    if (this.config.orchestrator.auth) {
      const authEndpoint = this.config.orchestrator.auth.endpoint.replace(/^ws(s?):/, 'http$1:')
      const authResult = await this._bus.dispatch({
        action: Actions.LocalRouteCreate,
        data: {
          name: 'auth-rpc',
          endpoint: authEndpoint,
          protocol: 'http' as const,
        },
      })
      if (authResult.success) {
        this.telemetry.logger.info`Registered core data channel: auth-rpc → ${authEndpoint}`
      } else {
        this.telemetry.logger
          .warn`Failed to register auth-rpc: ${'error' in authResult ? authResult.error : 'unknown'}`
      }

      // Wait for side-effects
      if (this._bus.lastNotificationPromise) {
        await this._bus.lastNotificationPromise
      }
    }
  }

  private async mintNodeToken(): Promise<void> {
    if (!this.config.orchestrator?.auth) {
      this.telemetry.logger.info`No auth service configured -- skipping node token mint`
      return
    }

    const { endpoint, systemToken } = this.config.orchestrator.auth
    this.telemetry.logger.info`Connecting to auth service at ${endpoint}`

    try {
      const authClient = newWebSocketRpcSession<AuthRpcApi>(endpoint)
      const tokensApi = await authClient.tokens(systemToken)

      if ('error' in tokensApi) {
        throw new Error(`Failed to access tokens API: ${tokensApi.error}`)
      }

      // Mint NODE token
      this._nodeToken = await tokensApi.create({
        subject: this.config.node.name,
        entity: {
          id: this.config.node.name,
          name: this.config.node.name,
          type: 'service',
          nodeId: this.config.node.name,
          trustedNodes: [], // Empty for now - could be populated from peer config
          trustedDomains: this.config.node.domains, // Domains this node trusts
        },
        principal: Principal.NODE,
        expiresIn: '7d', // Node token valid for 7 days
      })

      // Track issue and expiry times for refresh logic
      this._tokenIssuedAt = new Date()
      this._tokenExpiresAt = new Date(Date.now() + TOKEN_TTL_MS)

      this.telemetry.logger
        .info`Node token minted for ${this.config.node.name} (expires ${this._tokenExpiresAt.toISOString()})`
    } catch (error) {
      this.telemetry.logger.error`Failed to mint node token: ${error}`
      throw error
    }
  }

  private async refreshNodeTokenIfNeeded(): Promise<void> {
    if (!this.config.orchestrator?.auth || !this._tokenIssuedAt || !this._tokenExpiresAt) {
      return
    }

    const now = Date.now()
    const issuedTime = this._tokenIssuedAt.getTime()
    const expiryTime = this._tokenExpiresAt.getTime()
    const totalLifetime = expiryTime - issuedTime
    const refreshTime = issuedTime + totalLifetime * REFRESH_THRESHOLD

    if (now >= refreshTime) {
      this.telemetry.logger.info`Node token approaching expiration, refreshing...`
      try {
        await this.mintNodeToken()
        this.telemetry.logger.info`Node token refreshed successfully`
      } catch (error) {
        this.telemetry.logger.error`Failed to refresh node token: ${error}`
        // Don't throw - keep using existing token until it expires
      }
    }
  }

  /**
   * Request a SVID certificate from the local auth service PKI.
   *
   * Generates a P-384 ECDSA key pair, creates a CSR with the node's
   * SPIFFE URI, and has it signed by the auth service's Services CA.
   * The resulting cert + key + CA bundle forms the TLS config for Envoy.
   *
   * Non-fatal: if PKI is unavailable, the orchestrator continues without TLS.
   * Cross-node communication will fall back to plaintext (localhost-only remains
   * unaffected either way).
   */
  private async requestNodeCertificate(): Promise<void> {
    if (!this.config.orchestrator?.auth) {
      this.telemetry.logger.info`No auth service configured -- skipping node certificate request`
      return
    }

    const { endpoint, systemToken } = this.config.orchestrator.auth
    this.telemetry.logger.info`Requesting node SVID certificate from ${endpoint}`

    try {
      const authClient = newWebSocketRpcSession<AuthRpcApi>(endpoint)
      const pkiApi = await authClient.pki(systemToken)

      if ('error' in pkiApi) {
        this.telemetry.logger.warn`PKI API unavailable: ${pkiApi.error} -- continuing without TLS`
        return
      }

      // 1. Get CA bundle (includes trust domain)
      const caBundle = await pkiApi.getCaBundle()
      this.telemetry.logger.info`PKI trust domain: ${caBundle.trustDomain}`

      // 2. Generate P-384 key pair
      const keyPair = await crypto.subtle.generateKey(EC_ALGORITHM, true, ['sign', 'verify'])

      // 3. Create CSR with SPIFFE URI SAN
      const instanceId = this.config.node.name
      const spiffeId = `spiffe://${caBundle.trustDomain}/orchestrator/${instanceId}`

      const csr = await x509.Pkcs10CertificateRequestGenerator.create({
        name: `CN=${instanceId}`,
        keys: keyPair,
        signingAlgorithm: SIGNING_ALGORITHM,
        extensions: [new x509.SubjectAlternativeNameExtension([{ type: 'url', value: spiffeId }])],
      })

      // 4. Sign the CSR
      const signResult = await pkiApi.signCsr({
        csrPem: csr.toString('pem'),
        serviceType: 'orchestrator',
        instanceId,
      })

      if (!signResult.success) {
        this.telemetry.logger
          .warn`CSR signing failed: ${signResult.error} -- continuing without TLS`
        return
      }

      // 5. Export private key to PEM
      const pkcs8Der = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey)
      const privateKeyPem = x509.PemConverter.encode(pkcs8Der, 'PRIVATE KEY')

      // 6. Build full cert chain: leaf + intermediate CAs
      const certChain = [signResult.certificatePem, ...signResult.chain].join('\n')

      // 7. Build CA trust bundle: unique certs from both bundles
      const allCaCerts = new Set([...caBundle.servicesBundle, ...caBundle.transportBundle])
      const caBundlePem = [...allCaCerts].join('\n')

      // 8. Store TLS config
      this._tlsConfig = {
        certChain,
        privateKey: privateKeyPem,
        caBundle: caBundlePem,
        requireClientCert: true,
      }

      // 9. Track renewal time
      this._certRenewAt = new Date(signResult.renewAfter)

      this.telemetry.logger
        .info`Node SVID obtained (fingerprint: ${signResult.fingerprint}, renew after: ${signResult.renewAfter})`
    } catch (error) {
      this.telemetry.logger
        .warn`Failed to request node certificate: ${error} -- continuing without TLS`
      // Non-fatal: TLS is optional during bootstrap. Local communication
      // works without it; only cross-node traffic requires mTLS.
    }
  }

  /**
   * Set up periodic SVID certificate renewal.
   *
   * Checks every 5 minutes if the certificate has passed its renewal point
   * (50% of lifetime, as returned by the PKI in `renewAfter`). When renewal
   * is needed, requests a new certificate and pushes updated TLS config to Envoy.
   */
  private setupCertRenewal(): void {
    if (this._certRenewInterval) {
      clearInterval(this._certRenewInterval)
    }

    this._certRenewInterval = setInterval(async () => {
      if (!this._certRenewAt || Date.now() < this._certRenewAt.getTime()) return

      this.telemetry.logger.info`SVID certificate approaching expiry, renewing...`
      try {
        await this.requestNodeCertificate()
        if (this._tlsConfig) {
          this._bus.tlsConfig = this._tlsConfig
          await this._bus.pushEnvoyConfig()
          this.telemetry.logger.info`SVID certificate renewed and pushed to Envoy`
        }
      } catch (error) {
        this.telemetry.logger.error`Failed to renew SVID certificate: ${error}`
      }
    }, CERT_RENEW_CHECK_INTERVAL)
  }
}
