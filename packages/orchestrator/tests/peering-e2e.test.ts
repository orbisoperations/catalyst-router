
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import type { StartedTestContainer, StartedNetwork } from 'testcontainers';
import { GenericContainer, Wait, Network } from 'testcontainers';
import path from 'path';
import { newHttpBatchRpcSession } from 'capnweb';
import type { PublicApi } from '../../cli/src/client.js';

describe('Peering E2E Lifecycle (Containerized)', () => {
    const TIMEOUT = 300000; // 5 minutes

    let network: StartedNetwork;
    let peerA: StartedTestContainer;
    let peerB: StartedTestContainer;

    let portA: number;
    let portB: number;

    const imageName = 'catalyst-node:e2e-peer';

    // Resolve Repo Root correctly
    const repoRoot = path.resolve(__dirname, '../../../');

    console.log('Repo Root:', repoRoot);

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

    const getClient = (port: number) => {
        const url = `http://127.0.0.1:${port}/rpc`;
        return newHttpBatchRpcSession<PublicApi>(url, {
            fetch: fetch as unknown
        } as unknown as any);
    };

    // Helper: Execute a function against a fresh session
    const runOp = async <T>(port: number, operation: (mgmt: any) => Promise<T>): Promise<T> => {
        const client = getClient(port);
        // Do not await! Pipeline the capability request.
        const mgmt = client.connectionFromManagementSDK();
        return operation(mgmt);
    };

    it('should connect Peer A to Peer B and sync existing routes', async () => {
        // Pre-seed A with a service
        await runOp(portA, mgmt => mgmt.applyAction({
            resource: 'localRoute',
            resourceAction: 'create',
            data: {
                name: 'pre-existing-on-a',
                endpoint: 'http://a:9000',
                protocol: 'http:graphql'
            }
        }));

        // Wait for it to be actually in A's state
        let onA = false;
        for (let i = 0; i < 5; i++) {
            const routes = await runOp(portA, async mgmt => {
                const res = await mgmt.listLocalRoutes();
                return res.routes || [];
            });

            if (routes.some((r: any) => r.service.name === 'pre-existing-on-a')) {
                onA = true;
                break;
            }
            await new Promise(r => setTimeout(r, 500));
        }
        expect(onA).toBe(true);

        // Connect A to B using applyAction
        await runOp(portA, mgmt => mgmt.applyAction({
            resource: 'internalBGPConfig',
            resourceAction: 'create',
            data: {
                endpoint: 'http://peer-b:3000/rpc',
                domains: ['valid-secret']
            }
        }));

        // Wait and verify
        let connected = false;
        for (let i = 0; i < 60; i++) {
            await new Promise(r => setTimeout(r, 1000));
            try {
                const peers = await runOp(portA, async mgmt => {
                    const res = await mgmt.listPeers();
                    return res.peers || [];
                });

                if (peers.some((p: any) => p.id === 'peer-b')) {
                    connected = true;
                    break;
                }
            } catch { /* ignore */ }
        }
        expect(connected).toBe(true);

        // Verify B learned the pre-existing service immediately after connecting
        let synced = false;
        let lastRoutesB: any[] = [];
        for (let i = 0; i < 60; i++) { // Extreme iterations (60s)
            await new Promise(r => setTimeout(r, 1000));
            try {
                lastRoutesB = await runOp(portB, async mgmt => {
                    const res = await mgmt.listLocalRoutes();
                    return res.routes || [];
                });

                if (lastRoutesB.some((r: any) => r.service.name === 'pre-existing-on-a')) {
                    synced = true;
                    break;
                }
            } catch { /* ignore */ }
        }
        if (!synced) {
            console.error('Initial sync failed on B. Routes:', lastRoutesB);
        }
        expect(synced).toBe(true);
    }, 60000);

    it('should propagate services bidirectionally', async () => {
        // Add service on A -> Check on B
        await runOp(portA, mgmt => mgmt.applyAction({
            resource: 'localRoute',
            resourceAction: 'create',
            data: {
                name: 'service-on-a',
                endpoint: 'http://a:8080',
                protocol: 'http:graphql'
            }
        }));

        // Add service on B -> Check on A
        await runOp(portB, mgmt => mgmt.applyAction({
            resource: 'localRoute',
            resourceAction: 'create',
            data: {
                name: 'service-on-b',
                endpoint: 'http://b:8080',
                protocol: 'http:graphql'
            }
        }));

        // Verify propagation to B
        let propagatedToB = false;
        for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 1000));
            try {
                const routes = await runOp(portB, async mgmt => {
                    const res = await mgmt.listLocalRoutes();
                    return res.routes || [];
                });
                if (routes.some((r: any) => r.service.name === 'service-on-a')) {
                    propagatedToB = true;
                    break;
                }
            } catch { /* ignore */ }
        }

        // Verify propagation to A
        let propagatedToA = false;
        for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 1000));
            try {
                const routes = await runOp(portA, async mgmt => {
                    const res = await mgmt.listLocalRoutes();
                    return res.routes || [];
                });
                if (routes.some((r: any) => r.service.name === 'service-on-b')) {
                    propagatedToA = true;
                    break;
                }
            } catch { /* ignore */ }
        }

        expect(propagatedToB).toBe(true);
        expect(propagatedToA).toBe(true);
    }, 120000); // 2 mins total for bidir check

    it('should disconnect and cleanup routes', async () => {
        // Find the generated peer ID for peer-b
        let peerId: string | undefined;
        try {
            const peers = await runOp(portA, async mgmt => {
                const res = await mgmt.listPeers();
                return res.peers || [];
            });
            const peerBRecord = peers.find((p: any) => p.id === 'peer-b');
            peerId = peerBRecord?.id;
        } catch { /* ignore */ }

        console.log(`Discovered Peer ID on A for B: ${peerId}`);
        expect(peerId).toBeDefined();

        // Disconnect A from B
        await runOp(portA, mgmt => mgmt.applyAction({
            resource: 'internalBGPConfig',
            resourceAction: 'delete',
            data: {
                peerId: peerId!
            }
        }));

        // Verify cleanup on B (A's services should be gone)
        let cleanedOnB = false;
        let lastRoutesB: any[] = [];
        for (let i = 0; i < 15; i++) {
            await new Promise(r => setTimeout(r, 1000));
            try {
                lastRoutesB = await runOp(portB, async mgmt => {
                    const res = await mgmt.listLocalRoutes();
                    return res.routes || [];
                });
                if (!lastRoutesB.some((r: any) => r.service.name === 'service-on-a')) {
                    cleanedOnB = true;
                    break;
                }
            } catch { /* ignore */ }
        }

        // Verify cleanup on A (B's services should be gone)
        let cleanedOnA = false;
        let lastRoutesA: any[] = [];
        for (let i = 0; i < 15; i++) {
            await new Promise(r => setTimeout(r, 1000));
            try {
                lastRoutesA = await runOp(portA, async mgmt => {
                    const res = await mgmt.listLocalRoutes();
                    return res.routes || [];
                });
                if (!lastRoutesA.some((r: any) => r.service.name === 'service-on-b')) {
                    cleanedOnA = true;
                    break;
                }
            } catch { /* ignore */ }
        }

        if (!cleanedOnB) console.error('Cleanup failed on B. Routes:', lastRoutesB);
        if (!cleanedOnA) console.error('Cleanup failed on A. Routes:', lastRoutesA);

        expect(cleanedOnB).toBe(true);
        expect(cleanedOnA).toBe(true);
    }, 60000);

});
