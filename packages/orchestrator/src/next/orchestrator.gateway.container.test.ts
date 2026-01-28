import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  GenericContainer,
  Wait,
  Network,
  type StartedTestContainer,
  type StartedNetwork,
} from 'testcontainers'
import path from 'path'
import { spawnSync } from 'node:child_process'
import { newWebSocketRpcSession } from 'capnweb'
import type { PublicApi } from './orchestrator.js'

describe('Orchestrator Gateway Container Tests', () => {
  const TIMEOUT = 600000 // 10 minutes

  let network: StartedNetwork
  let gateway: StartedTestContainer
  let peerA: StartedTestContainer
  let peerB: StartedTestContainer
  const peerBLogs: string[] = []

  const orchestratorImage = 'localhost/catalyst-node:next-e2e'
  const gatewayImage = 'localhost/catalyst-gateway:test'
  const repoRoot = path.resolve(__dirname, '../../../../')
  const skipTests =
    !process.env.DOCKER_HOST && !process.env.DOCKER_SOCK && !process.env.PODMAN_VAR_LINK

  beforeAll(async () => {
    if (skipTests) {
      console.warn('Skipping container tests: Podman runtime not detected')
      return
    }

    // Build images
    console.log('Building Gateway image with Podman...')
    const gatewayBuild = spawnSync(
      'podman',
      ['build', '-f', 'packages/gateway/Dockerfile', '-t', gatewayImage, '.'],
      { cwd: repoRoot, stdio: 'inherit' }
    )
    if (gatewayBuild.status !== 0) throw new Error('Podman build gateway failed')

    console.log('Building Orchestrator image with Podman...')
    const orchestratorBuild = spawnSync(
      'podman',
      ['build', '-f', 'packages/orchestrator/Dockerfile', '-t', orchestratorImage, '.'],
      { cwd: repoRoot, stdio: 'inherit' }
    )
    if (orchestratorBuild.status !== 0) throw new Error('Podman build orchestrator failed')

    network = await new Network().start()

    gateway = await new GenericContainer(gatewayImage)
      .withNetwork(network)
      .withNetworkAliases('gateway')
      .withExposedPorts(4000)
      .withWaitStrategy(Wait.forListeningPorts())
      .withLogConsumer((stream) => {
        stream.on('line', (line) => console.log(`[gateway] ${line}`))
        stream.on('err', (line) => console.error(`[gateway] ERR: ${line}`))
      })
      .start()

    const startNode = async (name: string, alias: string, gatewayEndpoint?: string) => {
      return await new GenericContainer(orchestratorImage)
        .withNetwork(network)
        .withNetworkAliases(alias)
        .withExposedPorts(3000)
        .withCommand(['sh', '-c', 'bun run src/next/index.ts'])
        .withEnvironment({
          PORT: '3000',
          CATALYST_NODE_ID: name,
          CATALYST_PEERING_ENDPOINT: `ws://${alias}:3000/rpc`,
          CATALYST_DOMAINS: 'somebiz.local.io',
          CATALYST_PEERING_SECRET: 'valid-secret',
          CATALYST_GQL_GATEWAY_ENDPOINT: gatewayEndpoint || '',
        })
        .withWaitStrategy(Wait.forListeningPorts())
        .withLogConsumer(
          (stream: { on(event: string, listener: (line: string) => void): void }) => {
            stream.on('line', (line: string) => {
              console.log(`[${name}] ${line}`)
              if (name === 'peer-b.somebiz.local.io') {
                peerBLogs.push(line)
              }
            })
            stream.on('err', (line: string) => console.error(`[${name}] ERR: ${line}`))
          }
        )
        .start()
    }

    peerA = await startNode('peer-a.somebiz.local.io', 'peer-a')
    // peerB is configured with the gateway
    peerB = await startNode('peer-b.somebiz.local.io', 'peer-b', 'ws://gateway:4000/api')

    console.log('Containers started')
  }, TIMEOUT)

  afterAll(async () => {
    if (peerA) await peerA.stop()
    if (peerB) await peerB.stop()
    if (gateway) await gateway.stop()
    if (network) await network.stop()
  })

  it.skipIf(skipTests)(
    'Mesh-wide GraphQL Sync: A -> B -> Gateway',
    async () => {
      const portA = peerA.getMappedPort(3000)
      const clientA = newWebSocketRpcSession<PublicApi>(`ws://127.0.0.1:${portA}/rpc`)
      const mgmtA = clientA.getManagerConnection()

      const portB = peerB.getMappedPort(3000)
      const clientB = newWebSocketRpcSession<PublicApi>(`ws://127.0.0.1:${portB}/rpc`)
      const mgmtB = clientB.getManagerConnection()

      // 1. Peer A and B
      await mgmtB.addPeer({
        name: 'peer-a.somebiz.local.io',
        endpoint: 'ws://peer-a:3000/rpc',
        domains: ['somebiz.local.io'],
      })
      await mgmtA.addPeer({
        name: 'peer-b.somebiz.local.io',
        endpoint: 'ws://peer-b:3000/rpc',
        domains: ['somebiz.local.io'],
      })

      // Give it a moment for the handshake
      await new Promise((r) => setTimeout(r, 2000))

      // 2. A adds a GraphQL route
      const adminAuth = { userId: 'admin', roles: ['*'] }
      await clientA.dispatch(
        {
          action: 'local:route:create',
          data: { name: 'books-mesh', endpoint: 'http://books:8080', protocol: 'http:graphql' },
        },
        adminAuth
      )

      // 3. Verify Gateway receives config update (check peerB logs for success or use gateway logs)
      // Since we don't have an easy way to query the gateway state over HTTP in this test context
      // without extra work, we can check node logs.

      let sawSync = false
      for (let i = 0; i < 20; i++) {
        if (peerBLogs.some((l) => l.includes('Gateway sync successful'))) {
          sawSync = true
          break
        }
        await new Promise((r) => setTimeout(r, 500))
      }

      if (!sawSync) {
        console.log('Peer B Logs during failure:', peerBLogs.join('\n'))
      }
      expect(sawSync).toBe(true)
    },
    TIMEOUT
  )
})
