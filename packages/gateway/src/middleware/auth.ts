import type { Context, Next } from 'hono';
import * as jose from 'jose';
import type { AuthConfigSchema } from '../rpc/server.js';
import { z } from 'zod';

export type AuthConfig = z.infer<typeof AuthConfigSchema>;

// Cache JWKS to avoid fetching on every request
let jwksCache: jose.JSONWebKeySet | null = null;
let jwksCacheUrl: string | null = null;
let jwksCacheExpiry: number = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getJwks(jwksUrl: string): Promise<jose.JSONWebKeySet> {
    const now = Date.now();
    if (jwksCache && jwksCacheUrl === jwksUrl && now < jwksCacheExpiry) {
        return jwksCache;
    }

    const response = await fetch(jwksUrl);
    if (!response.ok) {
        throw new Error(`Failed to fetch JWKS: ${response.status}`);
    }

    jwksCache = await response.json() as jose.JSONWebKeySet;
    jwksCacheUrl = jwksUrl;
    jwksCacheExpiry = now + CACHE_TTL_MS;
    return jwksCache;
}

export interface JwtPayload {
    sub?: string;
    aud?: string | string[];
    iss?: string;
    exp?: number;
    iat?: number;
    [key: string]: unknown;
}

/**
 * Create JWT authentication middleware for Hono
 *
 * This middleware:
 * - Extracts Bearer token from Authorization header
 * - Validates JWT signature using JWKS
 * - Optionally validates issuer and audience claims
 * - Adds decoded payload to context for downstream handlers
 *
 * Requests without Authorization header pass through (for introspection, health checks)
 * Requests with invalid tokens are rejected with 401
 */
export function createAuthMiddleware(config: AuthConfig) {
    return async (c: Context, next: Next) => {
        const authHeader = c.req.header('Authorization');

        // No token = pass through (allow introspection, etc.)
        if (!authHeader) {
            return next();
        }

        if (!authHeader.startsWith('Bearer ')) {
            return c.json({ error: 'Invalid authorization header format' }, 401);
        }

        const token = authHeader.slice(7);

        try {
            const jwks = await getJwks(config.jwksUrl);
            const keySet = jose.createLocalJWKSet(jwks);

            const verifyOptions: jose.JWTVerifyOptions = {};
            if (config.issuer) {
                verifyOptions.issuer = config.issuer;
            }
            if (config.audience) {
                verifyOptions.audience = config.audience;
            }

            const { payload } = await jose.jwtVerify(token, keySet, verifyOptions);

            // Add claims to context for downstream handlers
            c.set('jwtPayload', payload);
            c.set('userId', payload.sub);

            return next();
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Token verification failed';
            console.error('[AuthMiddleware] JWT verification failed:', message);
            return c.json({ error: 'Invalid or expired token' }, 401);
        }
    };
}

/**
 * Clear the JWKS cache (useful for testing or when rotating keys)
 */
export function clearJwksCache(): void {
    jwksCache = null;
    jwksCacheUrl = null;
    jwksCacheExpiry = 0;
}
