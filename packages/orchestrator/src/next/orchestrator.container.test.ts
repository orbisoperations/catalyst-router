import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GenericContainer, Wait, Network, type StartedTestContainer, type StartedNetwork } from 'testcontainers'
import path from 'path'
import { spawnSync } from 'node:child_process'
import { newWebSocketRpcSession } from 'capnweb'
import type { PublicApi } from './orchestrator.js'

describe('Orchestrator Container Tests (Next)', () => {
    const TIMEOUT = 600000 // 10 minutes

    let network: StartedNetwork
    let peerA: StartedTestContainer
    let peerB: StartedTestContainer
    let peerC: StartedTestContainer

    const imageName = 'localhost/catalyst-node:next-e2e'
    const repoRoot = path.resolve(__dirname, '../../../../')
    // Look for Podman socket or generic DOCKER_HOST/SOCK which Podman often populates
    const skipTests = !process.env.DOCKER_HOST && !process.env.DOCKER_SOCK && !process.env.PODMAN_VAR_LINK

    beforeAll(async () => {
        if (skipTests) {
            console.warn('Skipping container tests: Podman runtime not detected (DOCKER_HOST/DOCKER_SOCK/PODMAN_VAR_LINK not set)');
            return
        }
        // Check if image exists
        const checkImage = spawnSync('podman', ['image', 'exists', imageName])
        if (checkImage.status !== 0) {
            console.log('Building Catalyst Node image with Podman...')
            const buildResult = spawnSync('podman', ['build', '-f', 'packages/orchestrator/Dockerfile', '-t', imageName, '.'], {
                cwd: repoRoot,
                stdio: 'inherit',
            })
            if (buildResult.status !== 0) throw new Error('Podman build failed')
        }

        network = await new Network().start()

        const startNode = async (name: string, alias: string) => {
            return await new GenericContainer(imageName)
                .withNetwork(network)
                .withNetworkAliases(alias)
                .withExposedPorts(3000)
                .withCommand(['sh', '-c', 'bun run src/next/index.ts'])
                .withEnvironment({
                    PORT: '3000',
                    CATALYST_NODE_ID: name,
                    CATALYST_PEERING_ENDPOINT: `ws://${alias}:3000/rpc`,
                })
                .withWaitStrategy(Wait.forLogMessage(/.*NEXT_ORCHESTRATOR_STARTED.*/))
                .withLogConsumer(stream => {
                    stream.on("line", line => console.log(`[${name}] ${line}`));
                    stream.on("err", line => console.error(`[${name}] ERR: ${line}`));
                })
                .start()
        }

        peerA = await startNode('A', 'peer-a')
        peerB = await startNode('B', 'peer-b')
        peerC = await startNode('C', 'peer-c')

        console.log('Nodes started')
    }, TIMEOUT)

    afterAll(async () => {
        if (peerA) await peerA.stop()
        if (peerB) await peerB.stop()
        if (peerC) await peerC.stop()
        if (network) await network.stop()
    })

    const getClient = (container: StartedTestContainer) => {
        const port = container.getMappedPort(3000)
        const url = `ws://127.0.0.1:${port}/rpc`
        return newWebSocketRpcSession<PublicApi>(url)
    }

    it.skipIf(skipTests)('A <-> B: peering and route sync', async () => {
        const clientA = getClient(peerA)
        const mgmtA = clientA.getManagerConnection()
        const clientB = getClient(peerB)
        const mgmtB = clientB.getManagerConnection()

        // 1. Configure BOTH nodes for peering
        await mgmtB.addPeer({
            name: 'A',
            endpoint: 'ws://peer-a:3000/rpc',
            domains: []
        })
        await mgmtA.addPeer({
            name: 'B',
            endpoint: 'ws://peer-b:3000/rpc',
            domains: []
        })

        // Give it a moment for the handshake
        await new Promise(r => setTimeout(r, 2000))

        // 2. A adds a local route
        await clientA.dispatch({
            action: 'local:route:create',
            data: { name: 'service-a', endpoint: 'http://a:8080', protocol: 'http' }
        })

        // 3. Verify B sees the route
        const inspectorB = clientB.getInspector()

        let sawRoute = false
        for (let i = 0; i < 20; i++) {
            const routes = await inspectorB.listRoutes()
            if (routes.internal.some((r: any) => r.name === 'service-a')) {
                sawRoute = true
                break
            }
            await new Promise(r => setTimeout(r, 500))
        }
        expect(sawRoute).toBe(true)
    }, TIMEOUT)

    it.skipIf(skipTests)('A <-> B <-> C: transit route propagation', async () => {
        const clientA = getClient(peerA)
        const clientB = getClient(peerB)
        const clientC = getClient(peerC)

        const mgmtA = clientA.getManagerConnection()
        const mgmtB = clientB.getManagerConnection()
        const mgmtC = clientC.getManagerConnection()

        // Configure A-B peering (reciprocal)
        await mgmtB.addPeer({ name: 'A', endpoint: 'ws://peer-a:3000/rpc', domains: [] })
        await mgmtA.addPeer({ name: 'B', endpoint: 'ws://peer-b:3000/rpc', domains: [] })

        // Configure B-C peering (reciprocal)
        await mgmtC.addPeer({ name: 'B', endpoint: 'ws://peer-b:3000/rpc', domains: [] })
        await mgmtB.addPeer({ name: 'C', endpoint: 'ws://peer-c:3000/rpc', domains: [] })

        // Wait for peering
        await new Promise(r => setTimeout(r, 2000))

        // 1. A adds a local route
        await clientA.dispatch({
            action: 'local:route:create',
            data: { name: 'service-transit', endpoint: 'http://a:9090', protocol: 'http' }
        })

        // 2. Verify C sees it via B
        const inspectorC = clientC.getInspector()
        let sawTransit = false
        for (let i = 0; i < 30; i++) {
            const routes = await inspectorC.listRoutes()
            const route = routes.internal.find((r: any) => r.name === 'service-transit')
            if (route) {
                expect(route.peerName).toBe('B') // Direct peer is B
                sawTransit = true
                break
            }
            await new Promise(r => setTimeout(r, 500))
        }
        expect(sawTransit).toBe(true)
    }, TIMEOUT)
})
