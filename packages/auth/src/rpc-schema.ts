
import { z } from 'zod';
import { SignOptionsSchema } from './jwt.js';

// Re-export SignOptionsSchema for RPC usage
export { SignOptionsSchema };

// Response for sign()
export const SignResponseSchema = z.object({
    token: z.string(),
});
export type SignResponse = z.infer<typeof SignResponseSchema>;

// Response for getJwks()
// We use a loose schema for JWKS to avoid tight coupling with 'jose' types in the RPC schema, 
// but we could strict it if needed. For now, matching JSONWebKeySet structure.
export const JwksResponseSchema = z.object({
    keys: z.array(z.record(z.string(), z.unknown())),
});
export type JwksResponse = z.infer<typeof JwksResponseSchema>;

// Request for verify()
export const VerifyRequestSchema = z.object({
    token: z.string(),
});
export type VerifyRequest = z.infer<typeof VerifyRequestSchema>;

// Response for verify()
export const VerifyResponseSchema = z.discriminatedUnion('valid', [
    z.object({
        valid: z.literal(true),
        payload: z.record(z.string(), z.unknown()),
    }),
    z.object({
        valid: z.literal(false),
        error: z.string(),
    }),
]);
export type VerifyResponse = z.infer<typeof VerifyResponseSchema>;

// Request for rotate()
export const RotateRequestSchema = z.object({
    immediate: z.boolean(),
});
export type RotateRequest = z.infer<typeof RotateRequestSchema>;

// Response for rotate()
export const RotateResponseSchema = z.object({
    success: z.boolean(),
});
export type RotateResponse = z.infer<typeof RotateResponseSchema>;
