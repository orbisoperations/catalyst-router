
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, Wait, StartedTestContainer } from 'testcontainers';
import { resolve } from 'path';

// Increase timeout for docker build
const TIMEOUT = 180_000;

describe('Auth Service Container', () => {
    let container: StartedTestContainer;
    let port: number;

    beforeAll(async () => {
        // Build image
        const buildContext = resolve(__dirname, '..');
        console.log('Building Docker image from', buildContext);

        const proc = Bun.spawn(['docker', 'build', '-t', 'auth-service:test', '.'], {
            cwd: buildContext,
            // stdout: 'inherit', // Uncomment for debugging build
            stderr: 'inherit'
        });
        await proc.exited;

        if (proc.exitCode !== 0) {
            throw new Error(`Docker build failed with exit code ${proc.exitCode}`);
        }

        container = await new GenericContainer('auth-service:test')
            .withExposedPorts(4020)
            .withEnvironment({
                CATALYST_AUTH_PORT: '4020',
                CATALYST_AUTH_KEYS_DIR: '/tmp/keys'
            })
            .withWaitStrategy(Wait.forHttp('/health', 4020))
            .start();

        port = container.getMappedPort(4020);
        console.log(`Container started on port ${port}`);
    }, TIMEOUT);

    afterAll(async () => {
        await container?.stop();
    });

    it('should expose RPC and sign/verify tokens', async () => {
        const url = `ws://localhost:${port}/rpc`;
        console.log(`Connecting to RPC at ${url}`);

        // Use newWebSocketRpcSession from capnweb
        // It returns a proxy object we can call directly? Or a session?
        // CLI client says it returns the stub. 
        // We need to cast it to our service type (conceptual)

        // dynamically import to ensure we get the right module if needed, 
        // but static import should work if we fix the name
        const { newWebSocketRpcSession } = await import('capnweb');

        // Bun has global WebSocket
        const client = newWebSocketRpcSession(url, {
            WebSocket: WebSocket as any
        });

        // client IS the service (remote capability)
        const service = client as any;

        // 1. Get JWKS
        const jwks = await service.getJwks();
        expect(jwks).toBeDefined();
        // Since schema return { keys: ... }
        expect(Array.isArray(jwks.keys)).toBe(true);
        expect(jwks.keys.length).toBeGreaterThanOrEqual(1);

        // 2. Sign
        const { token } = await service.sign({ subject: 'test-user', expiresIn: '1m' });
        expect(token).toBeDefined();
        expect(typeof token).toBe('string');

        // 3. Verify
        const verifyRes = await service.verify({ token });
        expect(verifyRes.valid).toBe(true);
        // Access payload from discriminated union
        if (verifyRes.valid) {
            expect(verifyRes.payload.sub).toBe('test-user');
        }

        // 4. Rotate
        // Provide immediate: false
        const rotateRes = await service.rotate({ immediate: false });
        expect(rotateRes.success).toBe(true);

        const jwks2 = await service.getJwks();
        expect(jwks2.keys.length).toBeGreaterThan(jwks.keys.length); // Should have added a key (or at least rotated)

        // Close? capnweb session might not expose close easily on the proxy object 
        // usually it relies on connection drop or has a .close() method if it is a session object
        // but for test we can just let it be or close container
    });
});
