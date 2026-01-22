
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { GenericContainer, Wait, StartedTestContainer, Network, StartedNetwork } from 'testcontainers';
import path from 'path';

describe('Peering E2E Lifecycle (Containerized)', () => {
    const TIMEOUT = 300000; // 5 minutes

    let network: StartedNetwork;
    let peerA: StartedTestContainer;
    let peerB: StartedTestContainer;

    let portA: number;
    let portB: number;

    const imageName = 'catalyst-node:e2e-peer';

    // Resolve Repo Root correctly
    // File is in packages/orchestrator/tests/peering-e2e.test.ts
    const repoRoot = path.resolve(__dirname, '../../../');
    const cliPath = path.resolve(repoRoot, 'packages/cli/src/index.ts');

    console.log('Repo Root:', repoRoot);
    console.log('CLI Path:', cliPath);

    beforeAll(async () => {
        // 1. Build Image
        console.log('Building Docker image...');
        const buildProc = Bun.spawn(['docker', 'build', '-f', 'packages/orchestrator/Dockerfile', '-t', imageName, '.'], {
            cwd: repoRoot,
            stdout: 'inherit',
            stderr: 'inherit'
        });
        await buildProc.exited;

        if (buildProc.exitCode !== 0) {
            throw new Error('Docker build failed');
        }

        // 2. Create Network
        network = await new Network().start();

        // 3. Start Peer A
        peerA = await new GenericContainer(imageName)
            .withNetwork(network)
            .withNetworkAliases('peer-a')
            .withExposedPorts(3000)
            .withEnvironment({
                'PORT': '3000',
                'CATALYST_AS': '100',
                'CATALYST_NODE_ID': 'peer-a'
            })
            .withWaitStrategy(Wait.forHttp('/health', 3000))
            .start();

        portA = peerA.getMappedPort(3000);
        console.log(`Peer A started on port ${portA}`);

        // 4. Start Peer B
        peerB = await new GenericContainer(imageName)
            .withNetwork(network)
            .withNetworkAliases('peer-b')
            .withExposedPorts(3000)
            .withEnvironment({
                'PORT': '3000',
                'CATALYST_AS': '200',
                'CATALYST_NODE_ID': 'peer-b'
            })
            .withWaitStrategy(Wait.forHttp('/health', 3000))
            .start();

        portB = peerB.getMappedPort(3000);
        console.log(`Peer B started on port ${portB}`);

        // Stream logs for debugging
        (await peerA.logs()).pipe(process.stdout);
        (await peerB.logs()).pipe(process.stdout);

    }, TIMEOUT);

    afterAll(async () => {
        if (peerA) await peerA.stop();
        if (peerB) await peerB.stop();
        if (network) await network.stop();
    });

    // Helper to run CLI command
    const runCli = async (args: string[], targetPort: number) => {
        const cmd = ['bun', cliPath, ...args];
        // console.log(`[CLI -> :${targetPort}] ${args.join(' ')}`);

        const proc = Bun.spawn(cmd, {
            stdout: 'pipe',
            stderr: 'pipe',
            env: {
                ...process.env,
                'CATALYST_ORCHESTRATOR_URL': `ws://localhost:${targetPort}/rpc`
            }
        });

        const output = await new Response(proc.stdout).text();
        const error = await new Response(proc.stderr).text();
        await proc.exited;

        if (proc.exitCode !== 0) {
            console.error(`CLI Command Failed: ${args.join(' ')}\nError:`, error);
            throw new Error(`CLI command failed: ${args.join(' ')}\nError: ${error}`);
        }
        return output;
    };

    it('should connect Peer A to Peer B', async () => {
        // Connect A to B (B is at peer-b:3000 inside network)
        await runCli(['peer', 'add', 'http://peer-b:3000/rpc', '--secret', 'valid-secret'], portA);

        // Wait and verify
        let connected = false;
        let lastOutput = '';
        for (let i = 0; i < 30; i++) { // Increased retries
            await new Promise(r => setTimeout(r, 1000));
            try {
                const output = await runCli(['peer', 'list'], portA);
                lastOutput = output;
                if (output.includes('peer-b')) {
                    connected = true;
                    break;
                }
            } catch (e) {
                // Ignore transient CLI errors during polling
            }
        }
        if (!connected) {
            console.error('Peer connection verification failed. Last Peer List Output:\n', lastOutput);
        }
        expect(connected).toBe(true);
    }, 30000); // Increased Timeout

    it('should propagate a service from A to B', async () => {
        // Add service on A
        await runCli(['service', 'add', 'test-service', 'http://test:8080'], portA);

        // Verify propagation to B
        let propagated = false;
        for (let i = 0; i < 30; i++) { // Increased retries
            await new Promise(r => setTimeout(r, 1000));
            try {
                const output = await runCli(['service', 'list'], portB);
                if (output.includes('test-service')) {
                    propagated = true;
                    break;
                }
            } catch (e) {
                // Ignore
            }
        }
        expect(propagated).toBe(true);
    }, 60000); // Increased Timeout

    it('should disconnect and cleanup routes', async () => {
        // Find the generated peer ID for peer-b
        const listOutput = await runCli(['peer', 'list'], portA);
        const peerIdMatch = listOutput.match(/peer-http[^\s|]+/);
        const peerId = peerIdMatch ? peerIdMatch[0] : 'peer-b';
        console.log(`Discovered Peer ID on A for B: ${peerId}`);

        // Disconnect A from B
        await runCli(['peer', 'remove', peerId], portA);

        // Verify cleanup on B
        let cleaned = false;
        let lastOutput = '';
        for (let i = 0; i < 15; i++) {
            await new Promise(r => setTimeout(r, 1000));
            try {
                const output = await runCli(['service', 'list'], portB);
                lastOutput = output;
                if (!output.includes('test-service')) {
                    cleaned = true;
                    break;
                }
            } catch (e) {
                // Ignore
            }
        }
        if (!cleaned) {
            console.error('Cleanup verification failed on B. Last Service List Output:\n', lastOutput);
        }
        expect(cleaned).toBe(true);
    }, 30000); // Increased Timeout

});
