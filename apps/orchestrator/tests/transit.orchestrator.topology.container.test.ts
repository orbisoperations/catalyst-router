import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newWebSocketRpcSession, type RpcStub } from 'capnweb'
import { execSync } from 'node:child_process'
import path from 'path'
import {
  GenericContainer,
  Network,
  Wait,
  type StartedNetwork,
  type StartedTestContainer,
} from 'testcontainers'
import type { DataChannel, NetworkClient, PublicApi } from '../src/orchestrator.js'
import { mintPeerToken, startAuthService, type AuthServiceContext } from './auth-test-helpers.js'

const isDockerRunning = () => {
  try {
    execSync('docker info', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const skipTests = !isDockerRunning()
if (skipTests) {
  console.warn('Skipping container tests: Docker is not running')
}

describe.skipIf(skipTests)('Orchestrator Transit Container Tests', () => {
  const TIMEOUT = 600000 // 10 minutes
  const orchestratorImage = 'catalyst-node:next-topology-e2e'
  const authImage = 'catalyst-auth:next-topology-e2e'
  const repoRoot = path.resolve(__dirname, '../../../')

  const buildImages = async () => {
    console.log('Building images for topology tests...')
    await GenericContainer.fromDockerfile(repoRoot, 'apps/orchestrator/Dockerfile').build(
      orchestratorImage,
      { deleteOnExit: false }
    )
    await GenericContainer.fromDockerfile(repoRoot, 'apps/auth/Dockerfile').build(authImage, {
      deleteOnExit: false,
    })
  }

  describe('Shared Auth: 3 nodes, 1 auth server', () => {
    let network: StartedNetwork
    let auth: AuthServiceContext
    let nodeA: StartedTestContainer
    let nodeB: StartedTestContainer
    let nodeC: StartedTestContainer

    beforeAll(async () => {
      await buildImages()
      network = await new Network().start()

      // Start shared auth service
      auth = await startAuthService(network, 'auth', authImage)

      const startNode = async (name: string, alias: string) => {
        console.log(`Starting node ${name}...`)
        const container = await new GenericContainer(orchestratorImage)
          .withNetwork(network)
          .withNetworkAliases(alias)
          .withExposedPorts(3000)
          .withEnvironment({
            PORT: '3000',
            CATALYST_NODE_ID: name,
            CATALYST_PEERING_ENDPOINT: `ws://${alias}:3000/rpc`,
            CATALYST_DOMAINS: 'somebiz.local.io',
            CATALYST_AUTH_ENDPOINT: auth.endpoint,
            CATALYST_SYSTEM_TOKEN: auth.systemToken,
          })
          .withWaitStrategy(Wait.forLogMessage('Catalyst server [orchestrator] listening'))
          .withLogConsumer(
            (stream: {
              on(event: string, listener: (line: string) => void): void
              pipe?: (dest: NodeJS.WritableStream) => void
            }) => {
              if (stream.pipe) stream.pipe(process.stdout)

              stream.on('line', (line: string) => {
                process.stdout.write(`[${name}] ${line}\n`)
              })
              stream.on('err', (line: string) => process.stderr.write(`[${name}] ERR: ${line}\n`))
            }
          )
          .start()
        console.log(`Node ${name} started and healthy.`)
        return container
      }

      nodeA = await startNode('node-a.somebiz.local.io', 'node-a')
      nodeB = await startNode('node-b.somebiz.local.io', 'node-b')
      nodeC = await startNode('node-c.somebiz.local.io', 'node-c')

      console.log('All nodes started.')
    }, TIMEOUT)

    afterAll(async () => {
      console.log('Teardown: Starting...')
      try {
        if (nodeA) await nodeA.stop()
        if (nodeB) await nodeB.stop()
        if (nodeC) await nodeC.stop()
        if (auth) await auth.container.stop()
        if (network) await network.stop()
        console.log('Teardown: Success')
      } catch (e) {
        console.error('Teardown: Error during stop (ignoring for test result)', e)
      }
    })

    const getClient = (node: StartedTestContainer) => {
      const port = node.getMappedPort(3000)
      return newWebSocketRpcSession<PublicApi>(`ws://127.0.0.1:${port}/rpc`)
    }

    const waitForConnected = async (
      client: RpcStub<PublicApi>,
      token: string,
      peerName: string
    ) => {
      for (let i = 0; i < 20; i++) {
        const netResult = await client.getNetworkClient(token)
        if (!netResult.success) throw new Error('Failed to get network client for check')
        const peers = await netResult.client.listPeers()
        const peer = peers.find((p) => p.name === peerName)
        if (peer && peer.connectionStatus === 'connected') return
        await new Promise((r) => setTimeout(r, 500))
      }
      throw new Error(`Peer ${peerName} failed to connect`)
    }

    it(
      'Transit Topology: A <-> B <-> C propagation, sync, and withdrawal',
      async () => {
        const clientA = getClient(nodeA)
        const clientB = getClient(nodeB)
        const clientC = getClient(nodeC)

        // 1. Linear Peering: A <-> B and B <-> C
        console.log('Establishing peering A <-> B')
        const netAResult = (await clientA.getNetworkClient(auth.systemToken)) as {
          success: true
          client: NetworkClient
        }
        const netBResult = (await clientB.getNetworkClient(auth.systemToken)) as {
          success: true
          client: NetworkClient
        }
        const netCResult = (await clientC.getNetworkClient(auth.systemToken)) as {
          success: true
          client: NetworkClient
        }

        if (!netAResult.success || !netBResult.success || !netCResult.success) {
          throw new Error('Failed to get network client')
        }

        const netA = netAResult.client
        const netB = netBResult.client
        const netC = netCResult.client

        // Setup B to accept A first, then A connects to B (Ensures A->B capability)
        await netB.addPeer({
          name: 'node-a.somebiz.local.io',
          endpoint: 'ws://node-a:3000/rpc',
          domains: ['somebiz.local.io'],
          peerToken: auth.systemToken,
        })
        await netA.addPeer({
          name: 'node-b.somebiz.local.io',
          endpoint: 'ws://node-b:3000/rpc',
          domains: ['somebiz.local.io'],
          peerToken: auth.systemToken,
        })

        // Wait for handshake
        console.log('Waiting for peering A <-> B to resolve...')
        await waitForConnected(clientA, auth.systemToken, 'node-b.somebiz.local.io')
        await waitForConnected(clientB, auth.systemToken, 'node-a.somebiz.local.io')

        // 2. A adds a local route
        console.log('Node A adding local route')
        const dataAResult = await clientA.getDataChannelClient(auth.systemToken)
        if (!dataAResult.success) throw new Error('Failed to get data client')
        await dataAResult.client.addRoute({
          name: 'service-a',
          protocol: 'http',
          endpoint: 'http://a:8080',
        })

        // Check B learned it
        let learnedOnB = false
        for (let i = 0; i < 40; i++) {
          const dataBResult = await clientB.getDataChannelClient(auth.systemToken)
          if (!dataBResult.success) throw new Error('Failed to get data client B')
          const routes = await dataBResult.client.listRoutes()
          if (routes.internal.some((r) => r.name === 'service-a')) {
            learnedOnB = true
            break
          }
          await new Promise((r) => setTimeout(r, 500))
        }
        expect(learnedOnB).toBe(true)

        // 3. NOW peer B with C (Initial Sync test)
        console.log('Establishing peering B <-> C')
        // Setup C to accept B first, then B connects to C (Ensures B->C capability)
        await netC.addPeer({
          name: 'node-b.somebiz.local.io',
          endpoint: 'ws://node-b:3000/rpc',
          domains: ['somebiz.local.io'],
          peerToken: auth.systemToken,
        })
        await netB.addPeer({
          name: 'node-c.somebiz.local.io',
          endpoint: 'ws://node-c:3000/rpc',
          domains: ['somebiz.local.io'],
          peerToken: auth.systemToken,
        })

        // Wait for B-C handshake and sync
        await new Promise((r) => setTimeout(r, 2000))

        // 4. C should have learned about A's route via B
        let learnedOnC = false
        for (let i = 0; i < 10; i++) {
          const dataCResult = await clientC.getDataChannelClient(auth.systemToken)
          if (!dataCResult.success) throw new Error('Failed to get data client C')
          const routes = await dataCResult.client.listRoutes()
          const routeA = routes.internal.find((r) => r.name === 'service-a')
          if (routeA) {
            learnedOnC = true
            // Verify nodePath: [B, A]
            expect(routeA.nodePath).toEqual(['node-b.somebiz.local.io', 'node-a.somebiz.local.io'])
            break
          }
          await new Promise((r) => setTimeout(r, 500))
        }
        expect(learnedOnC).toBe(true)

        // 5. Withdrawal Propagation: A deletes route -> B and C should remove it
        console.log('Node A deleting route')
        await (
          (await clientA.getDataChannelClient(auth.systemToken)) as {
            success: true
            client: DataChannel
          }
        ).client.removeRoute({
          name: 'service-a',
          protocol: 'http',
          endpoint: 'http://a:8080',
        })

        let removedOnC = false
        for (let i = 0; i < 10; i++) {
          const dataCResult = await clientC.getDataChannelClient(auth.systemToken)
          if (!dataCResult.success) throw new Error('Failed to get data client C')
          const routes = await dataCResult.client.listRoutes()
          if (!routes.internal.some((r) => r.name === 'service-a')) {
            removedOnC = true
            break
          }
          await new Promise((r) => setTimeout(r, 500))
        }
        expect(removedOnC).toBe(true)

        // 6. Topology Withdrawal: Disconnect A-B -> B should tell C to remove A's routes
        console.log('Re-adding route and then disconnecting A-B')
        await (
          (await clientA.getDataChannelClient(auth.systemToken)) as {
            success: true
            client: DataChannel
          }
        ).client.addRoute({
          name: 'service-a-v2',
          protocol: 'http',
          endpoint: 'http://a:8080',
        })

        // Wait for it to reach C
        await new Promise((r) => setTimeout(r, 2000))

        await netA.removePeer({ name: 'node-b.somebiz.local.io' })

        let disconnectedWithdrawalOnC = false
        for (let i = 0; i < 10; i++) {
          const dataCResult = await clientC.getDataChannelClient(auth.systemToken)
          if (!dataCResult.success) throw new Error('Failed to get data client C')
          const routes = await dataCResult.client.listRoutes()
          if (!routes.internal.some((r) => r.name === 'service-a-v2')) {
            disconnectedWithdrawalOnC = true
            break
          }
          await new Promise((r) => setTimeout(r, 500))
        }
        expect(disconnectedWithdrawalOnC).toBe(true)
      },
      TIMEOUT
    )
  })

  describe('Separate Auth: 3 nodes, 3 auth servers', () => {
    let network: StartedNetwork
    let authA: AuthServiceContext
    let authB: AuthServiceContext
    let authC: AuthServiceContext
    let nodeA: StartedTestContainer
    let nodeB: StartedTestContainer
    let nodeC: StartedTestContainer

    beforeAll(async () => {
      await buildImages()
      network = await new Network().start()

      // Start separate auth services
      authA = await startAuthService(network, 'auth-a', authImage, 'bootstrap-a')
      authB = await startAuthService(network, 'auth-b', authImage, 'bootstrap-b')
      authC = await startAuthService(network, 'auth-c', authImage, 'bootstrap-c')

      const startNode = async (
        name: string,
        alias: string,
        authEndpoint: string,
        systemToken: string
      ) => {
        console.log(`Starting node ${name}...`)
        const container = await new GenericContainer(orchestratorImage)
          .withNetwork(network)
          .withNetworkAliases(alias)
          .withExposedPorts(3000)
          .withEnvironment({
            PORT: '3000',
            CATALYST_NODE_ID: name,
            CATALYST_PEERING_ENDPOINT: `ws://${alias}:3000/rpc`,
            CATALYST_DOMAINS: 'somebiz.local.io',
            CATALYST_AUTH_ENDPOINT: authEndpoint,
            CATALYST_SYSTEM_TOKEN: systemToken,
          })
          .withWaitStrategy(Wait.forLogMessage('Catalyst server [orchestrator] listening'))
          .withLogConsumer(
            (stream: {
              on(event: string, listener: (line: string) => void): void
              pipe?: (dest: NodeJS.WritableStream) => void
            }) => {
              if (stream.pipe) stream.pipe(process.stdout)

              stream.on('line', (line: string) => {
                process.stdout.write(`[${name}] ${line}\n`)
              })
              stream.on('err', (line: string) => process.stderr.write(`[${name}] ERR: ${line}\n`))
            }
          )
          .start()
        console.log(`Node ${name} started and healthy.`)
        return container
      }

      nodeA = await startNode(
        'node-a.somebiz.local.io',
        'node-a',
        authA.endpoint,
        authA.systemToken
      )
      nodeB = await startNode(
        'node-b.somebiz.local.io',
        'node-b',
        authB.endpoint,
        authB.systemToken
      )
      nodeC = await startNode(
        'node-c.somebiz.local.io',
        'node-c',
        authC.endpoint,
        authC.systemToken
      )

      console.log('All nodes started with separate auth servers.')
    }, TIMEOUT)

    afterAll(async () => {
      console.log('Teardown: Starting...')
      try {
        if (nodeA) await nodeA.stop()
        if (nodeB) await nodeB.stop()
        if (nodeC) await nodeC.stop()
        if (authA) await authA.container.stop()
        if (authB) await authB.container.stop()
        if (authC) await authC.container.stop()
        if (network) await network.stop()
        console.log('Teardown: Success')
      } catch (e) {
        console.error('Teardown: Error during stop (ignoring for test result)', e)
      }
    })

    const getClient = (node: StartedTestContainer) => {
      const port = node.getMappedPort(3000)
      return newWebSocketRpcSession<PublicApi>(`ws://127.0.0.1:${port}/rpc`)
    }

    it(
      'Transit with separate auth servers',
      async () => {
        const clientA = getClient(nodeA)
        const clientB = getClient(nodeB)
        const clientC = getClient(nodeC)

        // Tokens should be unique
        expect(authA.systemToken).not.toBe(authB.systemToken)
        expect(authB.systemToken).not.toBe(authC.systemToken)
        expect(authA.systemToken).not.toBe(authC.systemToken)
        console.log('Confirmed: All system tokens are unique per auth server')

        // Each token works on its own node
        const netAResult = await clientA.getNetworkClient(authA.systemToken)
        expect(netAResult.success).toBe(true)

        const netBResult = await clientB.getNetworkClient(authB.systemToken)
        expect(netBResult.success).toBe(true)

        const netCResult = await clientC.getNetworkClient(authC.systemToken)
        expect(netCResult.success).toBe(true)

        console.log('All nodes authenticated with their respective auth servers')

        // Mint peer tokens for A <-> B peering
        console.log('Minting peer tokens for A <-> B...')
        const authAPort = authA.container.getMappedPort(5000)
        const authBPort = authB.container.getMappedPort(5000)
        const authCPort = authC.container.getMappedPort(5000)

        const peerTokenBtoA = await mintPeerToken(
          `ws://127.0.0.1:${authAPort}/rpc`,
          authA.systemToken,
          'node-b.somebiz.local.io',
          ['somebiz.local.io']
        )
        const peerTokenAtoB = await mintPeerToken(
          `ws://127.0.0.1:${authBPort}/rpc`,
          authB.systemToken,
          'node-a.somebiz.local.io',
          ['somebiz.local.io']
        )

        // Establish A <-> B peering
        const netA = (netAResult as { success: true; client: NetworkClient }).client
        const netB = (netBResult as { success: true; client: NetworkClient }).client
        const netC = (netCResult as { success: true; client: NetworkClient }).client

        await netB.addPeer({
          name: 'node-a.somebiz.local.io',
          endpoint: 'ws://node-a:3000/rpc',
          domains: ['somebiz.local.io'],
          peerToken: peerTokenBtoA,
        })
        await netA.addPeer({
          name: 'node-b.somebiz.local.io',
          endpoint: 'ws://node-b:3000/rpc',
          domains: ['somebiz.local.io'],
          peerToken: peerTokenAtoB,
        })

        // Add route on A and verify transit to C works
        const dataAResult = await clientA.getDataChannelClient(authA.systemToken)
        if (!dataAResult.success) throw new Error('Failed to get data client A')
        await dataAResult.client.addRoute({
          name: 'service-a',
          protocol: 'http',
          endpoint: 'http://a:8080',
        })

        // Wait for B to learn it
        await new Promise((r) => setTimeout(r, 2000))

        // Mint peer tokens for B <-> C peering
        console.log('Minting peer tokens for B <-> C...')
        const peerTokenCtoB = await mintPeerToken(
          `ws://127.0.0.1:${authBPort}/rpc`,
          authB.systemToken,
          'node-c.somebiz.local.io',
          ['somebiz.local.io']
        )
        const peerTokenBtoC = await mintPeerToken(
          `ws://127.0.0.1:${authCPort}/rpc`,
          authC.systemToken,
          'node-b.somebiz.local.io',
          ['somebiz.local.io']
        )

        // Establish B <-> C peering
        await netC.addPeer({
          name: 'node-b.somebiz.local.io',
          endpoint: 'ws://node-b:3000/rpc',
          domains: ['somebiz.local.io'],
          peerToken: peerTokenCtoB,
        })
        await netB.addPeer({
          name: 'node-c.somebiz.local.io',
          endpoint: 'ws://node-c:3000/rpc',
          domains: ['somebiz.local.io'],
          peerToken: peerTokenBtoC,
        })

        // Wait for sync
        await new Promise((r) => setTimeout(r, 2000))

        // Verify C learned about A's route via B (transit propagation)
        let learnedOnC = false
        for (let i = 0; i < 20; i++) {
          const dataCResult = await clientC.getDataChannelClient(authC.systemToken)
          if (!dataCResult.success) throw new Error('Failed to get data client C')
          const routes = await dataCResult.client.listRoutes()
          const routeA = routes.internal.find((r) => r.name === 'service-a')
          if (routeA) {
            learnedOnC = true
            expect(routeA.nodePath).toEqual(['node-b.somebiz.local.io', 'node-a.somebiz.local.io'])
            break
          }
          await new Promise((r) => setTimeout(r, 500))
        }
        expect(learnedOnC).toBe(true)
        console.log('Transit propagation successful with separate auth servers')
      },
      TIMEOUT
    )
  })
})
