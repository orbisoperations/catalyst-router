import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import {
  GenericContainer,
  Wait,
  Network,
  type StartedTestContainer,
  type StartedNetwork,
} from 'testcontainers'
import path from 'path'
import { spawnSync } from 'node:child_process'
import { newWebSocketRpcSession, type RpcStub } from 'capnweb'
import type { PublicApi, NetworkClient } from '../src/orchestrator.js'
import { startAuthService, mintPeerToken, type AuthServiceContext } from './auth-test-helpers.js'

const isDockerRunning = () => {
  try {
    const result = Bun.spawnSync(['docker', 'info'])
    return result.exitCode === 0
  } catch {
    return false
  }
}

const skipTests = !isDockerRunning()
if (skipTests) {
  console.warn('Skipping container tests: Docker is not running')
}

describe.skipIf(skipTests)('Orchestrator Peering Container Tests', () => {
  const TIMEOUT = 600000 // 10 minutes
  const orchestratorImage = 'catalyst-node:next-topology-e2e'
  const authImage = 'catalyst-auth:next-topology-e2e'
  const repoRoot = path.resolve(__dirname, '../../../')

  const buildImages = async () => {
    const checkImage = (imageName: string) =>
      spawnSync('docker', ['image', 'inspect', imageName]).status === 0

    if (!checkImage(orchestratorImage)) {
      console.log('Building Orchestrator image for Topology tests...')
      const orchestratorBuild = spawnSync(
        'docker',
        ['build', '-f', 'apps/orchestrator/Dockerfile', '-t', orchestratorImage, '.'],
        { cwd: repoRoot, stdio: 'inherit' }
      )
      if (orchestratorBuild.status !== 0) throw new Error('Docker build orchestrator failed')
    } else {
      console.log(`Using existing image: ${orchestratorImage}`)
    }

    if (!checkImage(authImage)) {
      console.log('Building Auth image for Topology tests...')
      const authBuild = spawnSync(
        'docker',
        ['build', '-f', 'apps/auth/Dockerfile', '-t', authImage, '.'],
        { cwd: repoRoot, stdio: 'inherit' }
      )
      if (authBuild.status !== 0) throw new Error('Docker build auth failed')
    } else {
      console.log(`Using existing image: ${authImage}`)
    }
  }

  describe('Shared Auth: 2 nodes, 1 auth server', () => {
    let network: StartedNetwork
    let auth: AuthServiceContext
    let nodeA: StartedTestContainer
    let nodeB: StartedTestContainer

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
          .withWaitStrategy(Wait.forLogMessage('NEXT_ORCHESTRATOR_STARTED'))
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

      console.log('All nodes started.')
    }, TIMEOUT)

    afterAll(async () => {
      console.log('Teardown: Starting...')
      try {
        if (nodeA) await nodeA.stop()
        if (nodeB) await nodeB.stop()
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
      'Shared auth tokens work on all nodes',
      async () => {
        const clientA = getClient(nodeA)
        const clientB = getClient(nodeB)

        // SECURITY TEST: Verify invalid tokens are rejected (SKIP_AUTH not set)
        console.log('Testing invalid token rejection...')
        const invalidToken = 'completely-invalid-token'
        const invalidOnA = await clientA.getNetworkClient(invalidToken)
        const invalidOnB = await clientB.getNetworkClient(invalidToken)

        expect(invalidOnA.success).toBe(false)
        expect(invalidOnB.success).toBe(false)
        console.log('✓ Invalid tokens correctly rejected')

        // Valid shared token works on both nodes
        const validOnA = await clientA.getNetworkClient(auth.systemToken)
        const validOnB = await clientB.getNetworkClient(auth.systemToken)
        expect(validOnA.success).toBe(true)
        expect(validOnB.success).toBe(true)
        console.log('✓ Shared auth token works on all nodes')
      },
      TIMEOUT
    )

    it(
      'Simple Peering: A <-> B propagation',
      async () => {
        const clientA = getClient(nodeA)
        const clientB = getClient(nodeB)

        // 1. Linear Peering: A <-> B
        console.log('Establishing peering A <-> B')
        const netAResult = await clientA.getNetworkClient(auth.systemToken)
        const netBResult = await clientB.getNetworkClient(auth.systemToken)

        if (!netAResult.success) {
          throw new Error(`Failed to get network client A: ${netAResult.error}`)
        }
        if (!netBResult.success) {
          throw new Error(`Failed to get network client B: ${netBResult.error}`)
        }

        const netA = (netAResult as { success: true; client: NetworkClient }).client
        const netB = (netBResult as { success: true; client: NetworkClient }).client

        // Setup B to accept A first, then A connects to B
        await netB.addPeer({
          name: 'node-a.somebiz.local.io',
          endpoint: 'ws://node-a:3000/rpc',
          domains: ['somebiz.local.io'],
        })
        await netA.addPeer({
          name: 'node-b.somebiz.local.io',
          endpoint: 'ws://node-b:3000/rpc',
          domains: ['somebiz.local.io'],
        })

        // Wait for handshake
        console.log('Waiting for peering A <-> B to resolve...')
        await waitForConnected(clientA, auth.systemToken, 'node-b.somebiz.local.io')
        await waitForConnected(clientB, auth.systemToken, 'node-a.somebiz.local.io')

        // 2. A adds a local route
        console.log('Node A adding local route')
        const dataAResult = await clientA.getDataChannelClient(auth.systemToken)
        if (!dataAResult.success) throw new Error('Failed to get data client')

        // Verify route doesn't exist on B yet
        const dataBBefore = await clientB.getDataChannelClient(auth.systemToken)
        if (!dataBBefore.success) throw new Error('Failed to get data client B')
        const routesBefore = await dataBBefore.client.listRoutes()
        expect(routesBefore.internal.some((r) => r.name === 'service-a')).toBe(false)
        console.log('✓ Confirmed route not on B before propagation')

        const routeResult = await dataAResult.client.addRoute({
          name: 'service-a',
          protocol: 'http',
          endpoint: 'http://a:8080',
        })

        if (!routeResult.success) {
          console.error('Route create failed:', routeResult)
          throw new Error(`Route create failed: ${routeResult.error || 'Unknown error'}`)
        }
        console.log('✓ Route added on A')

        // Check B learned it
        let learnedOnB = false
        let matchingRoute: any = null
        for (let i = 0; i < 40; i++) {
          const dataBResult = await clientB.getDataChannelClient(auth.systemToken)
          if (!dataBResult.success) throw new Error('Failed to get data client B')
          const routes = await dataBResult.client.listRoutes()
          matchingRoute = routes.internal.find((r) => r.name === 'service-a')
          if (matchingRoute) {
            learnedOnB = true
            break
          }
          await new Promise((r) => setTimeout(r, 500))
        }
        expect(learnedOnB).toBe(true)
        console.log('✓ Route propagated to B')

        // Verify route details match
        expect(matchingRoute.endpoint).toBe('http://a:8080')
        expect(matchingRoute.protocol).toBe('http')
        console.log('✓ Route details match')
      },
      TIMEOUT
    )
  })

  describe('Separate Auth: 2 nodes, 2 auth servers', () => {
    let network: StartedNetwork
    let authA: AuthServiceContext
    let authB: AuthServiceContext
    let nodeA: StartedTestContainer
    let nodeB: StartedTestContainer

    beforeAll(async () => {
      await buildImages()
      network = await new Network().start()

      // Start separate auth services
      authA = await startAuthService(network, 'auth-a', authImage, 'bootstrap-a')
      authB = await startAuthService(network, 'auth-b', authImage, 'bootstrap-b')

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
          .withWaitStrategy(Wait.forLogMessage('NEXT_ORCHESTRATOR_STARTED'))
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

      console.log('All nodes started with separate auth servers.')
    }, TIMEOUT)

    afterAll(async () => {
      console.log('Teardown: Starting...')
      try {
        if (nodeA) await nodeA.stop()
        if (nodeB) await nodeB.stop()
        if (authA) await authA.container.stop()
        if (authB) await authB.container.stop()
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
      'Each node uses its own auth server',
      async () => {
        const clientA = getClient(nodeA)
        const clientB = getClient(nodeB)

        // Tokens should be different
        expect(authA.systemToken).not.toBe(authB.systemToken)
        console.log('Confirmed: System tokens are unique per auth server')

        // Each token works on its own node
        const netAResult = await clientA.getNetworkClient(authA.systemToken)
        expect(netAResult.success).toBe(true)
        console.log('✓ Node A authenticated with auth-a token')

        const netBResult = await clientB.getNetworkClient(authB.systemToken)
        expect(netBResult.success).toBe(true)
        console.log('✓ Node B authenticated with auth-b token')

        // SECURITY TEST: Verify cross-auth tokens are rejected (no SKIP_AUTH)
        console.log('Testing cross-auth token rejection...')
        const crossAuthAtoB = await clientB.getNetworkClient(authA.systemToken)
        const crossAuthBtoA = await clientA.getNetworkClient(authB.systemToken)

        // Without SKIP_AUTH, cross-auth tokens should be rejected
        expect(crossAuthAtoB.success).toBe(false)
        expect(crossAuthBtoA.success).toBe(false)
        console.log('✓ Cross-auth tokens correctly rejected')

        // SECURITY TEST: Verify invalid tokens are rejected
        const invalidToken = 'completely-invalid-token'
        const invalidOnA = await clientA.getNetworkClient(invalidToken)
        const invalidOnB = await clientB.getNetworkClient(invalidToken)
        expect(invalidOnA.success).toBe(false)
        expect(invalidOnB.success).toBe(false)
        console.log('✓ Invalid tokens correctly rejected')
      },
      TIMEOUT
    )

    it(
      'Cross-node peering works with cert-bound peer tokens',
      async () => {
        const clientA = getClient(nodeA)
        const clientB = getClient(nodeB)

        // Mint peer tokens: Auth-A mints token for B→A, Auth-B mints token for A→B
        console.log('Minting peer tokens...')
        // Use mapped ports to connect from host machine to Docker containers
        const authAPort = authA.container.getMappedPort(5000)
        const authBPort = authB.container.getMappedPort(5000)

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

        const netAResult = await clientA.getNetworkClient(authA.systemToken)
        const netBResult = await clientB.getNetworkClient(authB.systemToken)

        if (!netAResult.success || !netBResult.success) {
          throw new Error('Failed to get network client')
        }

        const netA = netAResult.client
        const netB = netBResult.client

        // Setup peering with peer tokens
        // B→A uses token minted by Auth-A
        await netB.addPeer({
          name: 'node-a.somebiz.local.io',
          endpoint: 'ws://node-a:3000/rpc',
          domains: ['somebiz.local.io'],
          peerToken: peerTokenBtoA,
        })
        // A→B uses token minted by Auth-B
        await netA.addPeer({
          name: 'node-b.somebiz.local.io',
          endpoint: 'ws://node-b:3000/rpc',
          domains: ['somebiz.local.io'],
          peerToken: peerTokenAtoB,
        })

        // Wait for connection
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

        await waitForConnected(clientA, authA.systemToken, 'node-b.somebiz.local.io')
        await waitForConnected(clientB, authB.systemToken, 'node-a.somebiz.local.io')
        console.log('Cross-node peering established successfully with separate auth servers')

        // Verify route propagation with separate auth
        console.log('Testing route propagation with separate auth...')
        const dataAResult = await clientA.getDataChannelClient(authA.systemToken)
        if (!dataAResult.success) throw new Error('Failed to get data client A')

        // Verify route doesn't exist on B yet
        const dataBBefore = await clientB.getDataChannelClient(authB.systemToken)
        if (!dataBBefore.success) throw new Error('Failed to get data client B')
        const routesBefore = await dataBBefore.client.listRoutes()
        expect(routesBefore.internal.some((r) => r.name === 'service-separate-auth')).toBe(false)
        console.log('✓ Confirmed route not on B before propagation')

        const routeResult = await dataAResult.client.addRoute({
          name: 'service-separate-auth',
          protocol: 'http',
          endpoint: 'http://separate:9090',
        })

        if (!routeResult.success) {
          throw new Error(`Route create failed: ${routeResult.error || 'Unknown error'}`)
        }
        console.log('✓ Route added on A with separate auth')

        // Check B learned it
        let learnedOnB = false
        let matchingRoute: any = null
        for (let i = 0; i < 40; i++) {
          const dataBResult = await clientB.getDataChannelClient(authB.systemToken)
          if (!dataBResult.success) throw new Error('Failed to get data client B')
          const routes = await dataBResult.client.listRoutes()
          matchingRoute = routes.internal.find((r) => r.name === 'service-separate-auth')
          if (matchingRoute) {
            learnedOnB = true
            break
          }
          await new Promise((r) => setTimeout(r, 500))
        }
        expect(learnedOnB).toBe(true)
        console.log('✓ Route propagated to B with separate auth')

        // Verify route details match
        expect(matchingRoute.endpoint).toBe('http://separate:9090')
        expect(matchingRoute.protocol).toBe('http')
        console.log('✓ Route details match with separate auth')
      },
      TIMEOUT
    )
  })
})
