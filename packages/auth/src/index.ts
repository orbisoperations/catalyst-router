// Re-export for library usage
export * from './keys.js'
export {
  signToken,
  verifyToken,
  decodeToken,
  SignOptionsSchema,
  VerifyResultSchema,
} from './jwt.js'
export type { SignOptions, VerifyOptions, VerifyResult } from './jwt.js'
export * from './revocation.js'
export * from './key-manager/index.js'
export * from './rpc/schema.js'
export { AuthRpcServer, createAuthRpcHandler } from './rpc/server.js'
export * from './permissions.js'
export type { Role } from './permissions.js'
