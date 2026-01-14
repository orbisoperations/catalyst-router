import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { GenericContainer, Wait, StartedTestContainer } from 'testcontainers';
import { resolve } from 'path';
import { AuthClient } from '../src/clients/auth.js';

// Increase timeout for container build
const TIMEOUT = 180_000;

describe('AuthClient Integration', () => {
    let container: StartedTestContainer;
    let client: AuthClient;
    let rpcEndpoint: string;

    beforeAll(async () => {
        // Build auth service image from monorepo root
        const buildContext = resolve(__dirname, '../../..');
        const dockerfile = 'packages/auth/Dockerfile';

        console.log('Building auth service image...');
        const proc = Bun.spawn(['podman', 'build', '-t', 'auth-service:integration-test', '-f', dockerfile, '.'], {
            cwd: buildContext,
            stderr: 'inherit'
        });
        await proc.exited;

        if (proc.exitCode !== 0) {
            throw new Error(`Container build failed with exit code ${proc.exitCode}`);
        }

        console.log('Starting auth service container...');
        container = await new GenericContainer('auth-service:integration-test')
            .withExposedPorts(4020)
            .withEnvironment({
                PORT: '4020',
                CATALYST_AUTH_KEYS_DIR: '/tmp/keys'
            })
            .withWaitStrategy(Wait.forHttp('/health', 4020))
            .start();

        const port = container.getMappedPort(4020);
        const host = container.getHost();
        rpcEndpoint = `ws://${host}:${port}/rpc`;
        console.log(`Auth service running at ${rpcEndpoint}`);

        client = new AuthClient(rpcEndpoint);
    }, TIMEOUT);

    afterAll(async () => {
        client?.close();
        await container?.stop();
    });

    it('should sign a token via RPC', async () => {
        const result = await client.signToken({
            subject: 'test-user-123',
            expiresIn: '1h'
        });

        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.token).toBeDefined();
            expect(typeof result.token).toBe('string');
            // JWT format: header.payload.signature
            expect(result.token.split('.')).toHaveLength(3);
        }
    });

    it('should verify a valid token via RPC', async () => {
        // First sign a token
        const signResult = await client.signToken({
            subject: 'verify-test-user',
            expiresIn: '1h'
        });
        expect(signResult.success).toBe(true);
        if (!signResult.success) return;

        // Then verify it
        const verifyResult = await client.verifyToken(signResult.token);

        expect(verifyResult.valid).toBe(true);
        if (verifyResult.valid) {
            expect(verifyResult.payload.sub).toBe('verify-test-user');
        }
    });

    it('should reject an invalid token', async () => {
        const result = await client.verifyToken('invalid.token.here');

        expect(result.valid).toBe(false);
        if (!result.valid) {
            expect(result.error).toBeDefined();
        }
    });

    it('should get JWKS via RPC', async () => {
        const result = await client.getJwks();

        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.jwks).toBeDefined();
            expect(result.jwks.keys).toBeInstanceOf(Array);
            expect(result.jwks.keys.length).toBeGreaterThan(0);
            // Check first key has expected ECDSA properties
            const key = result.jwks.keys[0];
            expect(key.kty).toBe('EC');
            expect(key.crv).toBe('P-384');
            expect(key.kid).toBeDefined();
        }
    });

    it('should sign token with custom claims', async () => {
        const result = await client.signToken({
            subject: 'claims-test-user',
            expiresIn: '30m',
            claims: {
                role: 'admin',
                orgId: 'org-456'
            }
        });

        expect(result.success).toBe(true);
        if (!result.success) return;

        // Verify and check claims
        const verifyResult = await client.verifyToken(result.token);
        expect(verifyResult.valid).toBe(true);
        if (verifyResult.valid) {
            expect(verifyResult.payload.role).toBe('admin');
            expect(verifyResult.payload.orgId).toBe('org-456');
        }
    });

    it('should reuse connection across multiple operations', async () => {
        // Multiple sequential operations should work on same connection
        const results = await Promise.all([
            client.signToken({ subject: 'user-1' }),
            client.signToken({ subject: 'user-2' }),
            client.getJwks(),
        ]);

        expect(results[0].success).toBe(true);
        expect(results[1].success).toBe(true);
        expect(results[2].success).toBe(true);
    });
});
