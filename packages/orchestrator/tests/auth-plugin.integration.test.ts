import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { AuthPlugin } from '../src/plugins/implementations/auth.js';
import { RouteTable } from '../src/state/route-table.js';
import type { IAuthClient } from '../src/clients/auth.js';
import type { PluginContext } from '../src/plugins/types.js';

// Import real auth service components
import { EphemeralKeyManager } from '@catalyst/auth/key-manager';
import { AuthRpcServer } from '@catalyst/auth/rpc/server';
import type { SignTokenResponse, VerifyTokenResponse, GetJwksResponse } from '@catalyst/auth/rpc/schema';

/**
 * Integration test client that calls AuthRpcServer directly.
 * Tests real JWT signing/verification without WebSocket transport.
 */
class DirectAuthClient implements IAuthClient {
    constructor(private rpcServer: AuthRpcServer) {}

    async signToken(request: { subject: string; audience?: string; claims?: Record<string, unknown> }): Promise<SignTokenResponse> {
        return this.rpcServer.signToken(request);
    }

    async verifyToken(token: string, audience?: string): Promise<VerifyTokenResponse> {
        return this.rpcServer.verifyToken({ token, audience });
    }

    async getJwks(): Promise<GetJwksResponse> {
        return this.rpcServer.getJwks();
    }

    close(): void {
        // No-op for direct client
    }
}

describe('AuthPlugin integration', () => {
    let keyManager: EphemeralKeyManager;
    let rpcServer: AuthRpcServer;
    let authClient: IAuthClient;
    let plugin: AuthPlugin;

    beforeAll(async () => {
        keyManager = new EphemeralKeyManager();
        await keyManager.initialize();
        rpcServer = new AuthRpcServer(keyManager);
        authClient = new DirectAuthClient(rpcServer);
        plugin = new AuthPlugin(authClient);
    });

    afterAll(async () => {
        await keyManager.shutdown();
    });

    function createContext(authToken?: string): PluginContext {
        const ctx: PluginContext & { authToken?: string } = {
            action: { type: 'add', service: { name: 'test', url: 'http://test' } },
            state: new RouteTable(),
            authxContext: {},
        };
        if (authToken) {
            ctx.authToken = authToken;
        }
        return ctx;
    }

    it('should reject requests without token', async () => {
        const result = await plugin.apply(createContext());

        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.message).toContain('required');
        }
    });

    it('should accept valid token and extract claims', async () => {
        // Sign a real token
        const signResult = await authClient.signToken({
            subject: 'user-123',
            claims: { role: 'admin', orgId: 'org-456' },
        });
        expect(signResult.success).toBe(true);
        if (!signResult.success) return;

        // Verify through the plugin
        const result = await plugin.apply(createContext(signResult.token));

        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.ctx.authxContext.userId).toBe('user-123');
            expect(result.ctx.authxContext.roles).toEqual(['admin']);
            expect(result.ctx.authxContext.orgId).toBe('org-456');
        }
    });

    it('should reject tampered token', async () => {
        const signResult = await authClient.signToken({ subject: 'user-123' });
        expect(signResult.success).toBe(true);
        if (!signResult.success) return;

        // Tamper with the token (flip a character in the signature)
        const parts = signResult.token.split('.');
        const sig = parts[2];
        const tamperedSig = sig[0] === 'a' ? 'b' + sig.slice(1) : 'a' + sig.slice(1);
        const tamperedToken = `${parts[0]}.${parts[1]}.${tamperedSig}`;

        const result = await plugin.apply(createContext(tamperedToken));

        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.message).toContain('Invalid');
        }
    });

    it('should reject token with wrong audience', async () => {
        const pluginWithAudience = new AuthPlugin(authClient, { audience: 'service-a' });

        // Sign token for different audience
        const signResult = await authClient.signToken({
            subject: 'user-123',
            audience: 'service-b',
        });
        expect(signResult.success).toBe(true);
        if (!signResult.success) return;

        const result = await pluginWithAudience.apply(createContext(signResult.token));

        expect(result.success).toBe(false);
    });

    it('should accept token with matching audience', async () => {
        const pluginWithAudience = new AuthPlugin(authClient, { audience: 'service-a' });

        const signResult = await authClient.signToken({
            subject: 'user-123',
            audience: 'service-a',
        });
        expect(signResult.success).toBe(true);
        if (!signResult.success) return;

        const result = await pluginWithAudience.apply(createContext(signResult.token));

        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.ctx.authxContext.userId).toBe('user-123');
        }
    });

    it('should handle multiple roles', async () => {
        const signResult = await authClient.signToken({
            subject: 'user-123',
            claims: { roles: ['admin', 'developer', 'viewer'] },
        });
        expect(signResult.success).toBe(true);
        if (!signResult.success) return;

        const result = await plugin.apply(createContext(signResult.token));

        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.ctx.authxContext.roles).toEqual(['admin', 'developer', 'viewer']);
        }
    });

    it('should reject garbage token', async () => {
        const result = await plugin.apply(createContext('not.a.jwt'));

        expect(result.success).toBe(false);
    });
});
