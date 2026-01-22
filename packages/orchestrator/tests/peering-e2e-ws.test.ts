
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { GenericContainer, Wait, StartedTestContainer, Network, StartedNetwork } from 'testcontainers';
import path from 'path';
import { newWebSocketRpcSession } from 'capnweb';
import type { PublicApi } from '../../cli/src/client.js';

describe('Peering E2E Lifecycle (WebSocket Transport)', () => {
    const TIMEOUT = 300000; // 5 minutes

    let network: StartedNetwork;
    let peerA: StartedTestContainer;
    let peerB: StartedTestContainer;

    let portA: number;
    let portB: number;

    const imageName = 'catalyst-node:e2e-peer-ws';

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
                'CATALYST_PEERING_ENDPOINT': 'http://peer-a:3000/rpc',
                'CATALYST_IBGP_TRANSPORT': 'websocket'
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
                'CATALYST_PEERING_ENDPOINT': 'http://peer-b:3000/rpc',
                'CATALYST_IBGP_TRANSPORT': 'websocket'
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
        const url = `ws://127.0.0.1:${port}/rpc`;
        return newWebSocketRpcSession<PublicApi>(url);
    };

    // Helper: Execute a function against a fresh session
    // Even though WS is persistent, we can use this helper to keep the test structure identical
    const runOp = async <T>(port: number, operation: (mgmt: any) => Promise<T>): Promise<T> => {
        const client = getClient(port);
        // Note: For WS, we don't strictly *need* to pipeline like HTTP, but it shouldn't hurt.
        // However, WS sessions are NOT one-shot.
        const mgmt = await client.connectionFromManagementSDK();
        return operation(mgmt);
    };

    it('should connect Peer A to Peer B and sync existing routes', async () => {
        // Pre-seed A with a service
        await runOp(portA, mgmt => mgmt.applyAction({
            resource: 'localRoute',
            resourceAction: 'create',
            data: {
                name: 'pre-existing-on-a-ws',
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

            if (routes.some((r: any) => r.service.name === 'pre-existing-on-a-ws')) {
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
            } catch (e) { }
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

                if (lastRoutesB.some((r: any) => r.service.name === 'pre-existing-on-a-ws')) {
                    synced = true;
                    break;
                }
            } catch (e) { }
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
                name: 'service-on-a-ws',
                endpoint: 'http://a:8080',
                protocol: 'http:graphql'
            }
        }));

        // Add service on B -> Check on A
        await runOp(portB, mgmt => mgmt.applyAction({
            resource: 'localRoute',
            resourceAction: 'create',
            data: {
                name: 'service-on-b-ws',
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
                if (routes.some((r: any) => r.service.name === 'service-on-a-ws')) {
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
                const routes = await runOp(portA, async mgmt => {
                    const res = await mgmt.listLocalRoutes();
                    return res.routes || [];
                });
                if (routes.some((r: any) => r.service.name === 'service-on-b-ws')) {
                    propagatedToA = true;
                    break;
                }
            } catch (e) { }
        }

        expect(propagatedToB).toBe(true);
        expect(propagatedToA).toBe(true);
    }, 120000);

    it('should disconnect and cleanup routes', async () => {
        // Find the generated peer ID for peer-b
        let peerId: string | undefined;
        for (let i = 0; i < 10; i++) {
            try {
                const peers = await runOp(portA, async mgmt => {
                    const res = await mgmt.listPeers();
                    return res.peers || [];
                });
                const peerBRecord = peers.find((p: any) => p.id === 'peer-b');
                if (peerBRecord) {
                    peerId = peerBRecord.id;
                    break;
                }
            } catch (e) { }
            await new Promise(r => setTimeout(r, 1000));
        }

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
                if (!lastRoutesB.some((r: any) => r.service.name === 'service-on-a-ws')) {
                    cleanedOnB = true;
                    break;
                }
            } catch (e) { }
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
                if (!lastRoutesA.some((r: any) => r.service.name === 'service-on-b-ws')) {
                    cleanedOnA = true;
                    break;
                }
            } catch (e) { }
        }

        if (!cleanedOnB) console.error('Cleanup failed on B. Routes:', lastRoutesB);
        if (!cleanedOnA) console.error('Cleanup failed on A. Routes:', lastRoutesA);

        expect(cleanedOnB).toBe(true);
        expect(cleanedOnA).toBe(true);
    }, 60000);

});
