import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { Hono } from 'hono';
import { createAuthMiddleware, clearJwksCache } from '../src/middleware/auth.js';

// Use real auth components for integration testing
import { EphemeralKeyManager } from '@catalyst/auth/key-manager';

describe('JWT Middleware', () => {
    let keyManager: EphemeralKeyManager;
    let jwksUrl: string;
    let mockJwksServer: ReturnType<typeof Bun.serve>;
    let app: Hono;

    beforeAll(async () => {
        // Initialize key manager
        keyManager = new EphemeralKeyManager();
        await keyManager.initialize();

        // Create a mock JWKS server
        const port = 19876;
        mockJwksServer = Bun.serve({
            port,
            async fetch(req) {
                if (req.url.endsWith('/.well-known/jwks.json')) {
                    const jwks = await keyManager.getJwks();
                    return new Response(JSON.stringify(jwks), {
                        headers: { 'Content-Type': 'application/json' }
                    });
                }
                return new Response('Not found', { status: 404 });
            }
        });

        jwksUrl = `http://localhost:${port}/.well-known/jwks.json`;

        // Create test app with middleware
        app = new Hono();
        app.use('/*', createAuthMiddleware({ jwksUrl }));
        app.get('/protected', (c) => {
            const userId = c.get('userId');
            const payload = c.get('jwtPayload');
            return c.json({ userId, payload });
        });
    });

    afterAll(async () => {
        await keyManager.shutdown();
        mockJwksServer.stop();
    });

    beforeEach(() => {
        clearJwksCache();
    });

    it('should pass through without Authorization header', async () => {
        const res = await app.request('/protected');
        expect(res.status).toBe(200);

        const body = await res.json();
        expect(body.userId).toBeUndefined();
    });

    it('should validate Bearer token against JWKS', async () => {
        const token = await keyManager.sign({ subject: 'user-123' });

        const res = await app.request('/protected', {
            headers: { Authorization: `Bearer ${token}` }
        });

        expect(res.status).toBe(200);
        const body = await res.json() as any;
        expect(body.userId).toBe('user-123');
        expect(body.payload.sub).toBe('user-123');
    });

    it('should reject invalid token', async () => {
        const res = await app.request('/protected', {
            headers: { Authorization: 'Bearer invalid.token.here' }
        });

        expect(res.status).toBe(401);
        const body = await res.json() as any;
        expect(body.error).toBeDefined();
    });

    it('should reject malformed Authorization header', async () => {
        const res = await app.request('/protected', {
            headers: { Authorization: 'Basic dXNlcjpwYXNz' }
        });

        expect(res.status).toBe(401);
        const body = await res.json() as any;
        expect(body.error).toContain('Invalid authorization');
    });

    it('should add claims to context', async () => {
        const token = await keyManager.sign({
            subject: 'user-456',
            claims: { role: 'admin', orgId: 'org-789' }
        });

        const res = await app.request('/protected', {
            headers: { Authorization: `Bearer ${token}` }
        });

        expect(res.status).toBe(200);
        const body = await res.json() as any;
        expect(body.payload.role).toBe('admin');
        expect(body.payload.orgId).toBe('org-789');
    });

    it('should reject token with wrong audience when configured', async () => {
        // Create app with audience validation
        const strictApp = new Hono();
        strictApp.use('/*', createAuthMiddleware({
            jwksUrl,
            audience: 'correct-audience'
        }));
        strictApp.get('/protected', (c) => c.json({ ok: true }));

        // Sign token with wrong audience
        const token = await keyManager.sign({
            subject: 'user-123',
            audience: 'wrong-audience'
        });

        const res = await strictApp.request('/protected', {
            headers: { Authorization: `Bearer ${token}` }
        });

        expect(res.status).toBe(401);
    });

    it('should accept token with matching audience', async () => {
        const strictApp = new Hono();
        strictApp.use('/*', createAuthMiddleware({
            jwksUrl,
            audience: 'my-service'
        }));
        strictApp.get('/protected', (c) => c.json({ ok: true }));

        const token = await keyManager.sign({
            subject: 'user-123',
            audience: 'my-service'
        });

        const res = await strictApp.request('/protected', {
            headers: { Authorization: `Bearer ${token}` }
        });

        expect(res.status).toBe(200);
    });
});
