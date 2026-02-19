import type { ValidationResult } from '@catalyst/types'
import * as jose from 'jose'
import type {
  IKeyManager,
  IKeyStore,
  RotateOptions,
  RotationResult,
  SignOptions,
  VerifyOptions,
} from './index.js'

const ALGORITHM = 'ES384'
const DEFAULT_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000

interface ManagedKey {
  privateKey: jose.CryptoKey
  publicKey: jose.CryptoKey
  kid: string
  createdAt: number
  expiresAt?: number
}

export class PersistentLocalKeyManager implements IKeyManager {
  private currentKey: ManagedKey | null = null
  private previousKeys: ManagedKey[] = []
  private initialized = false
  private readonly issuer?: string

  constructor(
    private store: IKeyStore,
    private options: { gracePeriodMs?: number; issuer?: string } = {}
  ) {
    this.issuer = options.issuer
  }

  isInitialized(): boolean {
    return this.initialized
  }

  async initialize(): Promise<void> {
    if (this.initialized) return

    const savedJwks = await this.store.loadKeys()
    const hadExistingKeys = savedJwks && savedJwks.keys.length > 0

    if (hadExistingKeys) {
      console.log(
        JSON.stringify({
          level: 'info',
          msg: 'Loading existing keys from persistent storage',
          keyCount: savedJwks.keys.length,
        })
      )

      const now = Date.now()
      let expiredCount = 0

      // Load existing keys
      for (const jwk of savedJwks.keys) {
        const privateKey = (await jose.importJWK(jwk, ALGORITHM)) as jose.CryptoKey
        const publicKeyJwk = {
          ...jwk,
          d: undefined,
          p: undefined,
          q: undefined,
          dp: undefined,
          dq: undefined,
          qi: undefined,
        }
        const publicKey = (await jose.importJWK(publicKeyJwk, ALGORITHM)) as jose.CryptoKey

        const managed: ManagedKey = {
          privateKey,
          publicKey,
          kid: jwk.kid!,
          createdAt: (jwk as jose.JWK & { iat?: number }).iat || Date.now(),
          expiresAt: (jwk as jose.JWK & { exp?: number }).exp,
        }

        if (!managed.expiresAt) {
          this.currentKey = managed
          console.log(
            JSON.stringify({
              level: 'info',
              msg: 'Loaded current key',
              kid: managed.kid,
              createdAt: new Date(managed.createdAt).toISOString(),
            })
          )
        } else {
          const isExpired = managed.expiresAt <= now
          if (isExpired) {
            expiredCount++
            console.warn(
              JSON.stringify({
                level: 'warn',
                msg: 'Found expired key in storage',
                kid: managed.kid,
                createdAt: new Date(managed.createdAt).toISOString(),
                expiredAt: new Date(managed.expiresAt).toISOString(),
              })
            )
          } else {
            console.log(
              JSON.stringify({
                level: 'info',
                msg: 'Loaded previous key',
                kid: managed.kid,
                createdAt: new Date(managed.createdAt).toISOString(),
                expiresAt: new Date(managed.expiresAt).toISOString(),
              })
            )
          }
          this.previousKeys.push(managed)
        }
      }

      if (expiredCount > 0) {
        console.warn(
          JSON.stringify({
            level: 'warn',
            msg: 'Expired keys detected during initialization',
            expiredKeyCount: expiredCount,
            totalKeyCount: savedJwks.keys.length,
          })
        )
      }
    }

    if (!this.currentKey) {
      if (!hadExistingKeys) {
        console.warn(
          JSON.stringify({
            level: 'warn',
            msg: 'No keys found in storage - new deployment or storage was cleared',
            action: 'Generating new key',
          })
        )
      } else {
        console.warn(
          JSON.stringify({
            level: 'warn',
            msg: 'No current key found - only expired/previous keys in storage',
            action: 'Generating new key',
            previousKeyCount: this.previousKeys.length,
          })
        )
      }

      await this.generateNewKey()

      console.warn(
        JSON.stringify({
          level: 'warn',
          msg: 'New key generated during initialization',
          kid: this.currentKey!.kid,
          createdAt: new Date(this.currentKey!.createdAt).toISOString(),
        })
      )
    }

    this.initialized = true
  }

  private async generateNewKey(): Promise<ManagedKey> {
    const { publicKey, privateKey } = await jose.generateKeyPair(ALGORITHM, {
      extractable: true,
    })
    const publicKeyJwk = await jose.exportJWK(publicKey)
    const kid = await jose.calculateJwkThumbprint(publicKeyJwk, 'sha256')

    const newKey: ManagedKey = {
      privateKey: privateKey as jose.CryptoKey,
      publicKey: publicKey as jose.CryptoKey,
      kid,
      createdAt: Date.now(),
    }

    this.currentKey = newKey
    await this.persist()
    return newKey
  }

  private async persist(): Promise<void> {
    const keys: jose.JWK[] = []

    if (this.currentKey) {
      const jwk = await jose.exportJWK(this.currentKey.privateKey)
      keys.push({ ...jwk, kid: this.currentKey.kid, iat: this.currentKey.createdAt } as jose.JWK)
    }

    for (const prev of this.previousKeys) {
      const jwk = await jose.exportJWK(prev.privateKey)
      keys.push({
        ...jwk,
        kid: prev.kid,
        iat: prev.createdAt,
        exp: prev.expiresAt,
      } as jose.JWK)
    }

    await this.store.saveKeys({ keys })
  }

  async sign(options: SignOptions): Promise<string> {
    if (!this.currentKey) throw new Error('Not initialized')

    const builder = new jose.SignJWT(options.claims ?? {})
      .setProtectedHeader({ alg: ALGORITHM, kid: this.currentKey.kid })
      .setSubject(options.subject)
      .setIssuedAt()
      .setJti(crypto.randomUUID())
      .setExpirationTime(Math.floor((options.expiresAt ?? Date.now() + 3600000) / 1000))
      .setAudience(options.audience ?? [])

    if (this.issuer) {
      builder.setIssuer(this.issuer)
    }

    return builder.sign(this.currentKey.privateKey)
  }

  async verify(
    token: string,
    options?: VerifyOptions
  ): Promise<ValidationResult<Record<string, unknown>>> {
    try {
      const result = await jose.jwtVerify(
        token,
        async (header) => {
          if (this.currentKey && this.currentKey.kid === header.kid)
            return this.currentKey.publicKey
          const prev = this.previousKeys.find((k) => k.kid === header.kid)
          if (prev) return prev.publicKey
          throw new Error('Key not found')
        },
        {
          audience: options?.audience,
          algorithms: [ALGORITHM],
        }
      )

      return { valid: true, payload: result.payload as Record<string, unknown> }
    } catch (err: unknown) {
      return { valid: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async getJwks(): Promise<jose.JSONWebKeySet> {
    const keys: jose.JWK[] = []
    if (this.currentKey) {
      const jwk = await jose.exportJWK(this.currentKey.publicKey)
      keys.push({ ...jwk, kid: this.currentKey.kid, use: 'sig', alg: ALGORITHM })
    }
    for (const prev of this.previousKeys) {
      const jwk = await jose.exportJWK(prev.publicKey)
      keys.push({ ...jwk, kid: prev.kid, use: 'sig', alg: ALGORITHM })
    }
    return { keys }
  }

  async getCurrentKeyId(): Promise<string> {
    if (!this.currentKey) throw new Error('Not initialized')
    return this.currentKey.kid
  }

  async rotate(options?: RotateOptions): Promise<RotationResult> {
    const immediate = options?.immediate ?? false
    const gracePeriodMs =
      options?.gracePeriodMs ?? this.options.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS

    const oldKey = this.currentKey
    if (!oldKey) throw new Error('Not initialized')

    const newKey = await this.generateNewKey()

    if (!immediate) {
      oldKey.expiresAt = Date.now() + gracePeriodMs
      this.previousKeys.push(oldKey)
    } else {
      this.previousKeys = []
    }

    await this.persist()

    return {
      previousKeyId: oldKey.kid,
      newKeyId: newKey.kid,
      gracePeriodEndsAt: oldKey.expiresAt ? new Date(oldKey.expiresAt) : undefined,
    }
  }

  async shutdown(): Promise<void> {
    this.currentKey = null
    this.previousKeys = []
    this.initialized = false
  }
}
