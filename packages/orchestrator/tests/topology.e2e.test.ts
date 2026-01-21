import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import type { StartedTestContainer, StartedNetwork } from 'testcontainers'
import { GenericContainer, Wait, Network } from 'testcontainers'
import path from 'path'
import { newHttpBatchRpcSession } from 'capnweb'
import type { PublicApi, ManagementScope } from '../../cli/src/client.js'
import type { LocalRoute } from '../src/rpc/schema/index.js'
import type { AuthorizedPeer } from '../src/rpc/schema/peering.js'

describe('Topology E2E: Star (A center, B & C leaves)', () => {
  const TIMEOUT = 300000 // 5 minutes

  let network: StartedNetwork
  let peerA: StartedTestContainer
  let peerB: StartedTestContainer
  let peerC: StartedTestContainer

  let portA: number
  let portB: number
  let portC: number

  const imageName = 'catalyst-node:e2e-topology'

  // Resolve Repo Root correctly
  const repoRoot = path.resolve(__dirname, '../../../')

  beforeAll(async () => {
    // 1. Build Image
    console.log('Building Docker image...')
    const buildProc = Bun.spawn(
      ['docker', 'build', '-f', 'packages/orchestrator/Dockerfile', '-t', imageName, '.'],
      {
        cwd: repoRoot,
        stdout: 'inherit',
        stderr: 'inherit',
      }
    )
    await buildProc.exited

    if (buildProc.exitCode !== 0) {
      throw new Error('Docker build failed')
    }

    // 2. Create Network
    network = await new Network().start()

    // 3. Start Peer A (Center)
    peerA = await new GenericContainer(imageName)
      .withNetwork(network)
      .withNetworkAliases('peer-a')
      .withExposedPorts(3000)
      .withEnvironment({
        PORT: '3000',
        CATALYST_AS: '100',
        CATALYST_NODE_ID: 'peer-a',
        CATALYST_PEERING_ENDPOINT: 'http://peer-a:3000/rpc',
      })
      .withWaitStrategy(Wait.forHttp('/health', 3000))
      .start()

    portA = peerA.getMappedPort(3000)
    console.log(`Peer A started on port ${portA}`)

    // 4. Start Peer B (Leaf)
    peerB = await new GenericContainer(imageName)
      .withNetwork(network)
      .withNetworkAliases('peer-b')
      .withExposedPorts(3000)
      .withEnvironment({
        PORT: '3000',
        CATALYST_AS: '200',
        CATALYST_NODE_ID: 'peer-b',
        CATALYST_PEERING_ENDPOINT: 'http://peer-b:3000/rpc',
      })
      .withWaitStrategy(Wait.forHttp('/health', 3000))
      .start()

    portB = peerB.getMappedPort(3000)
    console.log(`Peer B started on port ${portB}`)

    // 5. Start Peer C (Leaf)
    peerC = await new GenericContainer(imageName)
      .withNetwork(network)
      .withNetworkAliases('peer-c')
      .withExposedPorts(3000)
      .withEnvironment({
        PORT: '3000',
        CATALYST_AS: '300',
        CATALYST_NODE_ID: 'peer-c',
        CATALYST_PEERING_ENDPOINT: 'http://peer-c:3000/rpc',
      })
      .withWaitStrategy(Wait.forHttp('/health', 3000))
      .start()

    portC = peerC.getMappedPort(3000)
    console.log(`Peer C started on port ${portC}`)

    // Stream logs for debugging
    ;(await peerA.logs()).pipe(process.stdout)
    ;(await peerB.logs()).pipe(process.stdout)
    ;(await peerC.logs()).pipe(process.stdout)
  }, TIMEOUT)

  afterAll(async () => {
    if (peerA) await peerA.stop()
    if (peerB) await peerB.stop()
    if (peerC) await peerC.stop()
    if (network) await network.stop()
  })

  const getClient = (port: number) => {
    const url = `http://127.0.0.1:${port}/rpc`
    return newHttpBatchRpcSession<PublicApi>(url)
  }

  const runOp = async <T>(
    port: number,
    operation: (mgmt: ManagementScope) => Promise<T>
  ): Promise<T> => {
    const client = getClient(port)
    const mgmt = client.connectionFromManagementSDK() // Pipelined
    return operation(mgmt as unknown as ManagementScope)
  }

  it('should propagate route from A to B and C', async () => {
    // 1. Connect A -> B
    await runOp(portA, (mgmt) =>
      mgmt.applyAction({
        resource: 'internalBGPConfig',
        resourceAction: 'create',
        data: {
          endpoint: 'http://peer-b:3000/rpc',
          domains: ['valid-secret'],
        },
      })
    )

    // 2. Connect A -> C
    await runOp(portA, (mgmt) =>
      mgmt.applyAction({
        resource: 'internalBGPConfig',
        resourceAction: 'create',
        data: {
          endpoint: 'http://peer-c:3000/rpc',
          domains: ['valid-secret'],
        },
      })
    )

    // WaitFor connections (check peers on A)
    let peersConnected = false
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      try {
        const peers = await runOp(portA, async (mgmt) => {
          const res = await mgmt.listPeers()
          return res.peers || []
        })

        // AuthorizedPeer is flat: { id, as, endpoint, domains }
        const hasB = peers.some((p: AuthorizedPeer) => p.id === 'peer-b')
        const hasC = peers.some((p: AuthorizedPeer) => p.id === 'peer-c')
        if (hasB && hasC) {
          peersConnected = true
          break
        }
      } catch {
        /* ignore */
      }
    }
    expect(peersConnected).toBe(true)
    console.log('Peers B and C connected to A')

    // 3. Publish Service on A
    const serviceName = 'datachannel-on-a'
    await runOp(portA, (mgmt) =>
      mgmt.applyAction({
        resource: 'localRoute',
        resourceAction: 'create',
        data: {
          name: serviceName,
          endpoint: 'http://a:9000',
          protocol: 'tcp',
        },
      })
    )
    console.log(`Service ${serviceName} published on A`)

    // 4. Verify B sees it
    let bSawIt = false
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      try {
        const routes = await runOp(portB, async (mgmt) => {
          const res = await mgmt.listLocalRoutes()
          return res.routes || []
        })
        console.log(
          `[Query B ${i}] Routes:`,
          routes.map((r: LocalRoute) => r.service.name)
        )
        if (routes.some((r: LocalRoute) => r.service.name === serviceName)) {
          bSawIt = true
          break
        }
      } catch (e) {
        console.error('Error checking B:', e)
      }
    }
    expect(bSawIt).toBe(true)
    console.log(`Peer B saw ${serviceName}`)

    // 5. Verify C sees it
    let cSawIt = false
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      try {
        const routes = await runOp(portC, async (mgmt) => {
          const res = await mgmt.listLocalRoutes()
          return res.routes || []
        })
        console.log(
          `[Query C ${i}] Routes:`,
          routes.map((r: LocalRoute) => r.service.name)
        )
        if (routes.some((r: LocalRoute) => r.service.name === serviceName)) {
          cSawIt = true
          break
        }
      } catch (e) {
        console.error('Error checking C:', e)
      }
    }
    expect(cSawIt).toBe(true)
    console.log(`Peer C saw ${serviceName}`)

    // =================================================================
    // Test 2: Propagation C -> A -> B
    // =================================================================
    console.log('--- Starting Propagation Test (C -> A -> B) ---')

    // 1. Publish Service on C
    const serviceOnC = 'datachannel-on-c'
    await runOp(portC, (mgmt) =>
      mgmt.applyAction({
        resource: 'localRoute',
        resourceAction: 'create',
        data: {
          name: serviceOnC,
          endpoint: 'http://c:9000',
          protocol: 'tcp',
        },
      })
    )
    console.log(`Service ${serviceOnC} published on C`)

    // 2. Verify A sees it (Direct Peer)
    // Path should be [300]
    let aSawIt = false
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      try {
        const routes = await runOp(portA, async (mgmt) => {
          const res = await mgmt.listLocalRoutes()
          return res.routes || []
        })
        const route = routes.find((r: LocalRoute) => r.service.name === serviceOnC)
        if (route) {
          aSawIt = true
          // Verify AS Path: C (300) -> A
          // A received [300] from C.
          expect(route.asPath).toEqual([300])
          break
        }
      } catch {
        /* ignore */
      }
    }
    expect(aSawIt).toBe(true)
    console.log(`Peer A saw ${serviceOnC}`)

    // 3. Verify B sees it (Propagated via A)
    // Path should be [100, 300] (A prepends its AS 100 to C's AS 300)
    let bSawC = false
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      try {
        const routes = await runOp(portB, async (mgmt) => {
          const res = await mgmt.listLocalRoutes()
          return res.routes || []
        })
        const route = routes.find((r: LocalRoute) => r.service.name === serviceOnC)
        if (route) {
          bSawC = true
          // TODO: Verify AS Path when implemented
          // expect(route.asPath).toEqual([100, 300]);
          break
        }
      } catch {
        /* ignore */
      }
    }
    expect(bSawC).toBe(true)
    console.log(`Peer B saw ${serviceOnC}`)
  }, 120000)
})
