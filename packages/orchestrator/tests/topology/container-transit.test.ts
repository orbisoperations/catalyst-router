
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { GenericContainer, Wait, StartedTestContainer, Network, StartedNetwork } from 'testcontainers';
import path from 'path';

describe('Topology: Transit Peering (Containerized)', () => {
    const TIMEOUT = 300000; // 5 minutes

    let network: StartedNetwork;
    let nodeA: StartedTestContainer;
    let nodeB: StartedTestContainer;
    let nodeC: StartedTestContainer;

    let portA: number;
    let portB: number;
    let portC: number;

    const imageName = 'catalyst-node:test';

    beforeAll(async () => {
        // 1. Build Image
        const repoRoot = path.resolve(__dirname, '../../../../');
        console.log('Building Docker image from repo root:', repoRoot);

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

        // 3. Start Node A (AS 100)
        nodeA = await new GenericContainer(imageName)
            .withNetwork(network)
            .withNetworkAliases('node-a')
            .withExposedPorts(3000)
            .withEnvironment({
                'PORT': '3000',
                'CATALYST_AS': '100',
                'CATALYST_DOMAINS': 'domain-a.internal',
                'CATALYST_NODE_ID': 'node-a'
            })
            // .withLogConsumer(stream => stream.pipe(process.stdout)) // Simple pipe
            .withWaitStrategy(Wait.forHttp('/health', 3000))
            .start();

        (await nodeA.logs()).pipe(process.stdout);
        portA = nodeA.getMappedPort(3000);
        console.log(`Node A started on port ${portA}`);

        // 4. Start Node B (AS 100)
        nodeB = await new GenericContainer(imageName)
            .withNetwork(network)
            .withNetworkAliases('node-b')
            .withExposedPorts(3000)
            .withEnvironment({
                'PORT': '3000',
                'CATALYST_AS': '100',
                'CATALYST_DOMAINS': 'domain-b.internal',
                'CATALYST_NODE_ID': 'node-b'
            })
            .withWaitStrategy(Wait.forHttp('/health', 3000))
            .start();
        (await nodeB.logs()).pipe(process.stdout);
        portB = nodeB.getMappedPort(3000);
        console.log(`Node B started on port ${portB}`);

        // 5. Start Node C (AS 100)
        nodeC = await new GenericContainer(imageName)
            .withNetwork(network)
            .withNetworkAliases('node-c')
            .withExposedPorts(3000)
            .withEnvironment({
                'PORT': '3000',
                'CATALYST_AS': '100',
                'CATALYST_DOMAINS': 'domain-c.internal',
                'CATALYST_NODE_ID': 'node-c'
            })
            .withWaitStrategy(Wait.forHttp('/health', 3000))
            .start();
        (await nodeC.logs()).pipe(process.stdout);
        portC = nodeC.getMappedPort(3000);
        console.log(`Node C started on port ${portC}`);

    }, TIMEOUT);

    afterAll(async () => {
        if (nodeA) await nodeA.stop();
        if (nodeB) await nodeB.stop();
        if (nodeC) await nodeC.stop();
        if (network) await network.stop();
    });

    // Helper to run CLI command
    const runCli = async (args: string[], targetPort: number) => {
        const cliPath = path.resolve(__dirname, '../../../cli/src/index.ts');
        const cmd = ['bun', cliPath, ...args];
        console.log(`[CLI -> :${targetPort}] ${args.join(' ')}`);

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
            console.error('CLI Error:', error);
            throw new Error(`CLI command failed: ${args.join(' ')}\nOutput: ${output}\nError: ${error}`);
        }
        return output;
    };

    it('should peer A -> B', async () => {
        // Connect A to B
        await runCli(['peer', 'add', 'ws://node-b:3000/rpc'], portA);
    }, 30000);

    it('should peer B -> C', async () => {
        // Connect B to C
        await runCli(['peer', 'add', 'ws://node-c:3000/rpc'], portB);

        // Wait for connection B->C
        let connected = false;
        console.log('Waiting for B->C connection...');
        for (let i = 0; i < 10; i++) {
            await new Promise(r => setTimeout(r, 1000));
            const peers = await runCli(['peer', 'list'], portB);
            console.log(`[Attempt ${i}] Peers on B: ${peers}`);
            if (peers.includes('node-c') && !peers.includes('No peers connected')) {
                console.log('B->C Connected');
                connected = true;
                break;
            }
        }
        if (!connected) throw new Error('B->C failed to connect');
    }, 30000);

    it('should verify A->B connection', async () => {
        // Wait for connection A->B
        let connected = false;
        console.log('Waiting for A->B connection...');
        for (let i = 0; i < 10; i++) {
            await new Promise(r => setTimeout(r, 1000));
            const peers = await runCli(['peer', 'list'], portA);
            console.log(`[Attempt ${i}] Peers on A: ${peers}`);
            if (peers.includes('node-b') && !peers.includes('No peers connected')) {
                console.log('A->B Connected');
                connected = true;
                break;
            }
        }
        if (!connected) throw new Error('A->B failed to connect');
    }, 30000);

    it('should register service on A', async () => {
        // Add Service on A
        await runCli(['service', 'add', 'service-a', 'http://a-backend:8080', '--protocol', 'tcp:http', '--fqdn', 'service-a.domain-a.internal'], portA);
    }, 30000);

    it('should propagate route to C', async () => {
        // Allow propagation
        await new Promise(r => setTimeout(r, 5000));

        // Debug: Check connections on B
        const peersB = await runCli(['peer', 'list'], portB);
        console.log('Peers on B:', peersB);

        // Check C
        // Target Node: C
        const output = await runCli(['routes', 'list'], portC);

        console.log('Routes on C:', output);
        expect(output).toContain('service-a');
        expect(output).toContain('node-b');
    }, 30000);

});
