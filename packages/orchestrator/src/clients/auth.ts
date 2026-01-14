/**
 * Auth Service RPC Client
 *
 * Connects to the auth service via WebSocket RPC to perform
 * token signing, verification, and JWKS retrieval.
 */

import { newWebSocketRpcSession } from 'capnweb';

// Import types from the auth package (single source of truth)
import type {
    SignTokenRequest,
    SignTokenResponse,
    VerifyTokenResponse,
    GetJwksResponse,
} from '@catalyst/auth/rpc/schema';

// Re-export for convenience
export type { SignTokenRequest, SignTokenResponse, VerifyTokenResponse, GetJwksResponse };

// RPC stub interface (what the remote service exposes)
interface AuthRpcStub {
    signToken(request: SignTokenRequest): Promise<SignTokenResponse>;
    verifyToken(request: { token: string; audience?: string }): Promise<VerifyTokenResponse>;
    getJwks(): Promise<GetJwksResponse>;
}

// Factory type for dependency injection (useful for testing)
type RpcSessionFactory = (endpoint: string) => AuthRpcStub;

/**
 * Interface for auth client operations
 */
export interface IAuthClient {
    signToken(request: SignTokenRequest): Promise<SignTokenResponse>;
    verifyToken(token: string, audience?: string): Promise<VerifyTokenResponse>;
    getJwks(): Promise<GetJwksResponse>;
    close(): void;
}

/**
 * Auth service RPC client
 *
 * Maintains a persistent WebSocket connection to the auth service.
 * Connection is lazily established on first use.
 *
 * Example usage:
 * ```typescript
 * const client = new AuthClient('ws://auth:4020/rpc');
 * const result = await client.signToken({ subject: 'user-123' });
 * if (result.success) {
 *     console.log('Token:', result.token);
 * }
 * // Clean up when done
 * client.close();
 * ```
 */
export class AuthClient implements IAuthClient {
    private readonly endpoint: string;
    private readonly sessionFactory: RpcSessionFactory;
    private stub: AuthRpcStub | null = null;
    private ws: WebSocket | null = null;

    constructor(
        endpoint: string,
        sessionFactory?: RpcSessionFactory
    ) {
        this.endpoint = endpoint;
        this.sessionFactory = sessionFactory ?? ((ep) => {
            // Create and store WebSocket for cleanup
            this.ws = new WebSocket(ep);
            return newWebSocketRpcSession(this.ws as any) as AuthRpcStub;
        });
    }

    /**
     * Get or create the RPC stub (lazy connection)
     */
    private getStub(): AuthRpcStub {
        if (!this.stub) {
            this.stub = this.sessionFactory(this.endpoint);
        }
        return this.stub;
    }

    /**
     * Close the WebSocket connection
     */
    close(): void {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.stub = null;
    }

    /**
     * Sign a JWT token for the given subject
     */
    async signToken(request: SignTokenRequest): Promise<SignTokenResponse> {
        try {
            const stub = this.getStub();
            return await stub.signToken(request);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'RPC error';
            return { success: false, error: message };
        }
    }

    /**
     * Verify a JWT token
     */
    async verifyToken(token: string, audience?: string): Promise<VerifyTokenResponse> {
        try {
            const stub = this.getStub();
            return await stub.verifyToken({ token, audience });
        } catch (error) {
            const message = error instanceof Error ? error.message : 'RPC error';
            return { valid: false, error: message };
        }
    }

    /**
     * Get the JWKS (public keys) from the auth service
     */
    async getJwks(): Promise<GetJwksResponse> {
        try {
            const stub = this.getStub();
            return await stub.getJwks();
        } catch (error) {
            const message = error instanceof Error ? error.message : 'RPC error';
            return { success: false, error: message };
        }
    }
}

/**
 * Create an auth client from environment variables
 */
export function createAuthClientFromEnv(): AuthClient | null {
    const endpoint = process.env.CATALYST_AUTH_ENDPOINT;
    if (!endpoint) {
        return null;
    }
    return new AuthClient(endpoint);
}
