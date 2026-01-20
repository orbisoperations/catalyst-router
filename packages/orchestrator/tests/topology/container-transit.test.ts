
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { GenericContainer, Wait, StartedTestContainer, Network, StartedNetwork } from 'testcontainers';
import path from 'path';
import { newHttpBatchRpcSession } from 'capnweb';
import type { PublicApi } from '../../cli/src/client.js';

describe('Topology: Transit Peering (Containerized)', () => {
    const TIMEOUT = 300000; // 5 minutes

    let network: StartedNetwork;
    let nodeA: StartedTestContainer;
    let nodeB: StartedTestContainer;
    let nodeC: StartedTestContainer;

    let portA: number;
    let portB: number;
    let portC: number;

    const imageName = 'catalyst-node:e2e-transit-rpc';

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
                'CATALYST_NODE_ID': 'node-a',
                'CATALYST_PEERING_ENDPOINT': 'http://node-a:3000/rpc'
            })
            .withWaitStrategy(Wait.forHttp('/health', 3000))
            .start();

        (await nodeA.logs()).pipe(process.stdout);
        portA = nodeA.getMappedPort(3000);
        console.log(`Node A started on port ${portA}`);

        // 4. Start Node B (AS 200)
        nodeB = await new GenericContainer(imageName)
            .withNetwork(network)
            .withNetworkAliases('node-b')
            .withExposedPorts(3000)
            .withEnvironment({
                'PORT': '3000',
                'CATALYST_AS': '200',
                'CATALYST_DOMAINS': 'domain-b.internal',
                'CATALYST_NODE_ID': 'node-b',
                'CATALYST_PEERING_ENDPOINT': 'http://node-b:3000/rpc'
            })
            .withWaitStrategy(Wait.forHttp('/health', 3000))
            .start();
        (await nodeB.logs()).pipe(process.stdout);
        portB = nodeB.getMappedPort(3000);
        console.log(`Node B started on port ${portB}`);

        // 5. Start Node C (AS 300)
        nodeC = await new GenericContainer(imageName)
            .withNetwork(network)
            .withNetworkAliases('node-c')
            .withExposedPorts(3000)
            .withEnvironment({
                'PORT': '3000',
                'CATALYST_AS': '300',
                'CATALYST_DOMAINS': 'domain-c.internal',
                'CATALYST_NODE_ID': 'node-c',
                'CATALYST_PEERING_ENDPOINT': 'http://node-c:3000/rpc'
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

    const getClient = (port: number) => {
        const url = `http://127.0.0.1:${port}/rpc`;
        return newHttpBatchRpcSession<PublicApi>(url, {
            fetch: fetch as any
        } as any);
    };

    const runOp = async <T>(port: number, operation: (mgmt: any) => Promise<T>): Promise<T> => {
        const client = getClient(port);
        const mgmt = client.connectionFromManagementSDK(); // Pipelined
        return operation(mgmt);
    };

    it('should peer A -> B', async () => {
        // Connect A to B
        await runOp(portA, mgmt => mgmt.applyAction({
            resource: 'internalBGPConfig',
            resourceAction: 'create',
            data: {
                endpoint: 'http://node-b:3000/rpc',
                domains: ['valid-secret']
            }
        }));
    }, 30000);

    it('should peer B -> C', async () => {
        // Connect B to C
        await runOp(portB, mgmt => mgmt.applyAction({
            resource: 'internalBGPConfig',
            resourceAction: 'create',
            data: {
                endpoint: 'http://node-c:3000/rpc',
                domains: ['valid-secret']
            }
        }));

        // Wait for connection B->C
        let connected = false;
        console.log('Waiting for B->C connection...');
        for (let i = 0; i < 20; i++) {
            await new Promise(r => setTimeout(r, 1000));
            try {
                const peers = await runOp(portB, async mgmt => {
                    const res = await mgmt.listPeers();
                    return res.peers || [];
                });
                const peerIds = peers.map((p: any) => p.id);
                console.log(`[Attempt ${i}] Peers on B: ${peerIds}`);
                if (peerIds.includes('node-c')) {
                    console.log('B->C Connected');
                    connected = true;
                    break;
                }
            } catch (e) {
                console.warn('RPC check failed:', e);
            }
        }
        if (!connected) throw new Error('B->C failed to connect');
    }, 30000);

    it('should verify A->B connection', async () => {
        // Wait for connection A->B
        let connected = false;
        console.log('Waiting for A->B connection...');
        for (let i = 0; i < 20; i++) {
            await new Promise(r => setTimeout(r, 1000));
            try {
                const peers = await runOp(portA, async mgmt => {
                    const res = await mgmt.listPeers();
                    return res.peers || [];
                });
                const peerIds = peers.map((p: any) => p.id);
                console.log(`[Attempt ${i}] Peers on A: ${peerIds}`);
                if (peerIds.includes('node-b')) {
                    console.log('A->B Connected');
                    connected = true;
                    break;
                }
            } catch (e) { }
        }
        if (!connected) throw new Error('A->B failed to connect');
    }, 30000);

    it('should register service on A', async () => {
        // Add Service on A
        await runOp(portA, mgmt => mgmt.applyAction({
            resource: 'localRoute',
            resourceAction: 'create',
            data: {
                name: 'service-a',
                endpoint: 'http://a-backend:8080',
                protocol: 'http',
                region: 'us-east'
            }
        }));
    }, 30000);

    it('should propagate route to C', async () => {
        // Poll for propagation (up to 60s)
        let found = false;
        for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 2000));

            try {
                const routes = await runOp(portC, async mgmt => {
                    const res = await mgmt.listLocalRoutes();
                    return res.routes || [];
                });
                const routeNames = routes.map((r: any) => r.service.name);
                console.log(`[Attempt ${i}] Routes on C:`, routeNames);

                if (routeNames.includes('service-a')) {
                    found = true;
                    break;
                }
            } catch (e) { }
        }

        if (!found) {
            // Debug: Check connections on B
            const peersB = await runOp(portB, async mgmt => {
                const res = await mgmt.listPeers();
                return res.peers || [];
            });
            console.log('Peers on B (Debug):', peersB.map((p: any) => p.id));
            throw new Error(`Route propagation failed.`);
        }
    }, 60000);

});
