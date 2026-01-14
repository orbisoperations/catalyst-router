import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, StartedTestContainer } from 'testcontainers';
import { resolve } from 'path';
import { execSync } from 'child_process';

// Increase timeout for container build
const TIMEOUT = 180_000;

// Skip rebuild if image exists (set REBUILD_IMAGES=true to force rebuild)
const FORCE_REBUILD = process.env.REBUILD_IMAGES === 'true';

function imageExists(imageName: string): boolean {
    try {
        const output = execSync(`podman images -q ${imageName}`, { encoding: 'utf-8' });
        return output.trim().length > 0;
    } catch {
        return false;
    }
}

function ensureImage(imageName: string, dockerfile: string, buildContext: string): void {
    if (!FORCE_REBUILD && imageExists(imageName)) {
        console.log(`Using existing image: ${imageName}`);
        return;
    }

    console.log(`Building image: ${imageName}...`);
    execSync(`podman build -t ${imageName} -f ${dockerfile} .`, {
        cwd: buildContext,
        stdio: 'inherit',
    });
}

describe('Auth Service Container', () => {
    let container: StartedTestContainer;
    let port: number;
    const buildContext = resolve(__dirname, '../../..');

    beforeAll(async () => {
        const imageName = 'auth-service:test';
        const dockerfile = 'packages/auth/Dockerfile';

        ensureImage(imageName, dockerfile, buildContext);

        console.log('Starting container with testcontainers...');
        container = await new GenericContainer(imageName)
            .withExposedPorts(4020)
            .withEnvironment({
                CATALYST_AUTH_PORT: '4020',
                CATALYST_AUTH_KEYS_DIR: '/tmp/keys'
            })
            .start();

        port = container.getMappedPort(4020);
        console.log(`Auth service started on port ${port}`);
    }, TIMEOUT);

    afterAll(async () => {
        if (container) await container.stop();
    }, TIMEOUT);

    it('should expose RPC and sign/verify tokens', async () => {
        const url = `ws://localhost:${port}/rpc`;
        console.log(`Connecting to RPC at ${url}`);

        const { newWebSocketRpcSession } = await import('capnweb');

        const client = newWebSocketRpcSession(url, {
            WebSocket: WebSocket as any
        });

        const service = client as any;

        // 1. Get JWKS
        const jwks = await service.getJwks();
        expect(jwks).toBeDefined();
        expect(Array.isArray(jwks.keys)).toBe(true);
        expect(jwks.keys.length).toBeGreaterThanOrEqual(1);

        // 2. Sign
        const { token } = await service.sign({ subject: 'test-user', expiresIn: '1m' });
        expect(token).toBeDefined();
        expect(typeof token).toBe('string');

        // 3. Verify
        const verifyRes = await service.verify({ token });
        expect(verifyRes.valid).toBe(true);
        if (verifyRes.valid) {
            expect(verifyRes.payload.sub).toBe('test-user');
        }

        // 4. Rotate
        const rotateRes = await service.rotate({ immediate: false });
        expect(rotateRes.success).toBe(true);

        const jwks2 = await service.getJwks();
        expect(jwks2.keys.length).toBeGreaterThan(jwks.keys.length);
    });
});
