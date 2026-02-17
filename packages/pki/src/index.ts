// Types
export type {
  CertificateRecord,
  CertificateType,
  CertificateStatus,
  ServiceType as PkiServiceType,
  DenyListEntry,
  ICertificateStore,
  ISigningBackend,
  SignCertificateParams,
  KeyUsageFlags,
  ExtKeyUsage,
  ValidatedCSR,
  SignCSRRequest,
  SignCSRResult,
  CaBundleResponse,
  PkiHealthStatus,
  PkiStatusResponse,
  CaStatusInfo,
} from './types.js'

// Schemas
export {
  SignCSRRequestSchema,
  DenyIdentityRequestSchema,
  AllowIdentityRequestSchema,
} from './types.js'

// SPIFFE utilities
export { parseSpiffeId, buildSpiffeId, isValidSpiffeId, type SpiffeId } from './spiffe.js'

// Config re-exports (from @catalyst/config, re-exported for convenience)
export {
  PkiConfigSchema,
  PkiProviderConfigSchema,
  LocalPkiConfigSchema,
  GCloudKmsPkiConfigSchema,
  AwsKmsPkiConfigSchema,
} from '@catalyst/config'
export type { PkiConfig, PkiProviderConfig } from '@catalyst/config'

// Implementations
export { BunSqliteCertificateStore } from './store/sqlite-certificate-store.js'
export { WebCryptoSigningBackend } from './signing/webcrypto-signing-backend.js'
export { CertificateManager } from './certificate-manager.js'
export type { CertificateManagerConfig } from './certificate-manager.js'
