
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
                'CATALYST_NODE_ID': 'peer-a',
                'CATALYST_PEERING_ENDPOINT': 'http://peer-a:3000/rpc'
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
                'CATALYST_NODE_ID': 'peer-b',
                'CATALYST_PEERING_ENDPOINT': 'http://peer-b:3000/rpc'
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
                'CATALYST_ORCHESTRATOR_URL': `ws://127.0.0.1:${targetPort}/rpc`,
                'NODE_ENV': 'test',
                'DEBUG': '1'
            }
        });

        const output = await new Response(proc.stdout).text();
        const error = await new Response(proc.stderr).text();
        await proc.exited;

        if (proc.exitCode !== 0) {
            console.error(`CLI Command Failed: ${args.join(' ')}\nError:`, error);
            console.log(`CLI Output:\n`, output);
            throw new Error(`CLI command failed: ${args.join(' ')}\nError: ${error}\nOutput: ${output}`);
        }
        return output;
    };

    it('should connect Peer A to Peer B and sync existing routes', async () => {
        // Pre-seed A with a service
        await runCli(['service', 'add', 'pre-existing-on-a', 'http://a:9000'], portA);

        // Wait for it to be actually in A's state
        let onA = false;
        for (let i = 0; i < 5; i++) {
            const out = await runCli(['service', 'list'], portA);
            if (out.includes('pre-existing-on-a')) {
                onA = true;
                break;
            }
            await new Promise(r => setTimeout(r, 500));
        }
        expect(onA).toBe(true);

        // Connect A to B (B is at peer-b:3000 inside network)
        await runCli(['peer', 'add', 'http://peer-b:3000/rpc', '--secret', 'valid-secret'], portA);

        // Wait and verify
        let connected = false;
        let lastOutput = '';
        for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 1000));
            try {
                const output = await runCli(['peer', 'list'], portA);
                lastOutput = output;
                if (output.includes('peer-b')) {
                    connected = true;
                    break;
                }
            } catch (e) { }
        }
        if (!connected) console.error('Peer connection verification failed. Last Peer List Output:\n', lastOutput);
        expect(connected).toBe(true);

        // Verify B learned the pre-existing service immediately after connecting
        let synced = false;
        let lastOutputB = '';
        for (let i = 0; i < 60; i++) { // Extreme iterations (60s)
            await new Promise(r => setTimeout(r, 1000));
            try {
                const output = await runCli(['service', 'list'], portB);
                lastOutputB = output;
                if (output.includes('pre-existing-on-a')) {
                    synced = true;
                    break;
                }
            } catch (e) { }
        }
        if (!synced) {
            console.error('Initial sync failed on B. Service List Output:\n', lastOutputB);
        }
        expect(synced).toBe(true);
    }, 60000);

    it('should propagate services bidirectionally', async () => {
        // Add service on A -> Check on B
        await runCli(['service', 'add', 'service-on-a', 'http://a:8080'], portA);
        // Add service on B -> Check on A
        await runCli(['service', 'add', 'service-on-b', 'http://b:8080'], portB);

        // Verify propagation to B
        let propagatedToB = false;
        for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 1000));
            try {
                const output = await runCli(['service', 'list'], portB);
                if (output.includes('service-on-a')) {
                    propagatedToB = true;
                    break;
                }
            } catch (e) { }
        }

        // Verify propagation to A
        let propagatedToA = false;
        for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 1000));
            try {
                const output = await runCli(['service', 'list'], portA);
                if (output.includes('service-on-b')) {
                    propagatedToA = true;
                    break;
                }
            } catch (e) { }
        }

        expect(propagatedToB).toBe(true);
        expect(propagatedToA).toBe(true);
    }, 120000); // 2 mins total for bidir check

    it('should disconnect and cleanup routes', async () => {
        // Find the generated peer ID for peer-b
        const listOutput = await runCli(['peer', 'list'], portA);
        const peerIdMatch = listOutput.match(/peer-http[^\s|]+/);
        const peerId = peerIdMatch ? peerIdMatch[0] : 'peer-b';
        console.log(`Discovered Peer ID on A for B: ${peerId}`);

        // Disconnect A from B
        await runCli(['peer', 'remove', peerId], portA);

        // Verify cleanup on B (A's services should be gone)
        let cleanedOnB = false;
        let lastOutputB = '';
        for (let i = 0; i < 15; i++) {
            await new Promise(r => setTimeout(r, 1000));
            try {
                const output = await runCli(['service', 'list'], portB);
                lastOutputB = output;
                if (!output.includes('service-on-a')) {
                    cleanedOnB = true;
                    break;
                }
            } catch (e) { }
        }

        // Verify cleanup on A (B's services should be gone)
        let cleanedOnA = false;
        let lastOutputA = '';
        for (let i = 0; i < 15; i++) {
            await new Promise(r => setTimeout(r, 1000));
            try {
                const output = await runCli(['service', 'list'], portA);
                lastOutputA = output;
                if (!output.includes('service-on-b')) {
                    cleanedOnA = true;
                    break;
                }
            } catch (e) { }
        }

        if (!cleanedOnB) console.error('Cleanup failed on B. Output:\n', lastOutputB);
        if (!cleanedOnA) console.error('Cleanup failed on A. Output:\n', lastOutputA);

        expect(cleanedOnB).toBe(true);
        expect(cleanedOnA).toBe(true);
    }, 60000);

});
