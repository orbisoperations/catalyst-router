import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { newWebSocketRpcSession } from 'capnweb'
import type { Readable } from 'node:stream'
import path from 'path'
import {
  GenericContainer,
  Network,
  Wait,
  type StartedNetwork,
  type StartedTestContainer,
} from 'testcontainers'
import type { PublicApi } from '../src/orchestrator.js'
import {
  mintDataCustodianToken,
  mintNodeCustodianToken,
  mintPeerToken,
  startAuthService,
  type AuthServiceContext,
} from './auth-test-helpers.js'

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

describe.skipIf(skipTests)('Orchestrator Gateway Container Tests', () => {
  const TIMEOUT = 600000 // 10 minutes
  const orchestratorImage = 'catalyst-node:next-topology-e2e'
  const authImage = 'catalyst-auth:next-topology-e2e'
  const gatewayImage = 'catalyst-gateway:test'
  const booksImage = 'catalyst-example-books:test'
  const repoRoot = path.resolve(__dirname, '../../../')

  const buildImages = async () => {
    console.log('Building Gateway image...')
    const gatewayBuild = Bun.spawnSync(
      ['docker', 'build', '-f', 'apps/gateway/Dockerfile', '-t', gatewayImage, '.'],
      { cwd: repoRoot, stdout: 'inherit', stderr: 'inherit' }
    )
    if (gatewayBuild.exitCode !== 0) {
      throw new Error(`docker build gateway failed: ${gatewayBuild.exitCode}`)
    }

    console.log('Building Books service image...')
    const booksBuild = Bun.spawnSync(
      ['docker', 'build', '-f', 'examples/books-api/Dockerfile', '-t', booksImage, '.'],
      { cwd: repoRoot, stdout: 'inherit', stderr: 'inherit' }
    )
    if (booksBuild.exitCode !== 0) {
      throw new Error(`docker build books failed: ${booksBuild.exitCode}`)
    }

    console.log('Building Orchestrator image...')
    const orchestratorBuild = Bun.spawnSync(
      ['docker', 'build', '-f', 'apps/orchestrator/Dockerfile', '-t', orchestratorImage, '.'],
      { cwd: repoRoot, stdout: 'inherit', stderr: 'inherit' }
    )
    if (orchestratorBuild.exitCode !== 0) {
      throw new Error(`docker build orchestrator failed: ${orchestratorBuild.exitCode}`)
    }

    console.log('Building Auth image...')
    const authBuild = Bun.spawnSync(
      ['docker', 'build', '-f', 'apps/auth/Dockerfile', '-t', authImage, '.'],
      { cwd: repoRoot, stdout: 'inherit', stderr: 'inherit' }
    )
    if (authBuild.exitCode !== 0) {
      throw new Error(`docker build auth failed: ${authBuild.exitCode}`)
    }
  }

  describe('Shared Auth', () => {
    let network: StartedNetwork
    let auth: AuthServiceContext
    let gateway: StartedTestContainer
    let peerA: StartedTestContainer
    let peerB: StartedTestContainer
    let books: StartedTestContainer
    const peerBLogs: string[] = []
    let dataCustodianToken: string = ''
    let nodeCustodianToken: string = ''

    beforeAll(async () => {
      await buildImages()
      network = await new Network().start()

      // Start shared auth service
      auth = await startAuthService(network, 'auth', authImage)

      const startContainer = async (
        name: string,
        alias: string,
        waitMsg: string,
        env: Record<string, string> = {},
        ports: number[] = []
      ) => {
        let image = orchestratorImage
        if (alias === 'gateway') image = gatewayImage
        if (alias === 'books') image = booksImage

        let container = new GenericContainer(image)
          .withNetwork(network)
          .withNetworkAliases(alias)
          .withWaitStrategy(Wait.forLogMessage(waitMsg))
          .withLogConsumer((stream: Readable) => {
            stream.pipe(process.stdout)
            stream.on('data', (data: Buffer | string) => {
              if (alias === 'peer-b') {
                peerBLogs.push(data.toString())
              }
            })
          })

        if (ports.length > 0) {
          ports.forEach((p) => (container = container.withExposedPorts(p)))
        }
        if (Object.keys(env).length > 0) {
          container = container.withEnvironment(env)
        }
        return await container.start()
      }

      gateway = await startContainer(
        'gateway',
        'gateway',
        'Catalyst server [gateway] listening',
        {
          CATALYST_NODE_ID: 'gateway',
          CATALYST_DOMAINS: 'somebiz.local.io',
          CATALYST_AUTH_ENDPOINT: auth.endpoint,
        },
        [4000]
      )

      const nodeEnv = (name: string, alias: string, gq: string = '') => ({
        PORT: '3000',
        CATALYST_NODE_ID: name,
        CATALYST_PEERING_ENDPOINT: `ws://${alias}:3000/rpc`,
        CATALYST_DOMAINS: 'somebiz.local.io',
        CATALYST_AUTH_ENDPOINT: auth.endpoint,
        CATALYST_SYSTEM_TOKEN: auth.systemToken,
        CATALYST_GQL_GATEWAY_ENDPOINT: gq,
      })

      peerA = await startContainer(
        'peer-a.somebiz.local.io',
        'peer-a',
        'Catalyst server [orchestrator] listening',
        nodeEnv('peer-a.somebiz.local.io', 'peer-a'),
        [3000]
      )
      peerB = await startContainer(
        'peer-b.somebiz.local.io',
        'peer-b',
        'Catalyst server [orchestrator] listening',
        nodeEnv('peer-b.somebiz.local.io', 'peer-b', 'ws://gateway:4000/api'),
        [3000]
      )
      books = await startContainer('books', 'books', 'BOOKS_STARTED', {}, [8080])

      const hostUrl = `ws://${auth.container.getHost()}:${auth.container.getFirstMappedPort()}/rpc`

      dataCustodianToken = await mintDataCustodianToken(
        hostUrl,
        auth.systemToken,
        'peer-a.somebiz.local.io',
        ['somebiz.local.io']
      )
      nodeCustodianToken = await mintNodeCustodianToken(
        hostUrl,
        auth.systemToken,
        'peer-a.somebiz.local.io',
        ['somebiz.local.io']
      )

      console.log('Containers started')
    }, TIMEOUT)

    afterAll(async () => {
      console.log('Teardown: Starting...')
      try {
        if (peerA) await peerA.stop()
        if (peerB) await peerB.stop()
        if (books) await books.stop()
        if (gateway) await gateway.stop()
        if (auth) await auth.container.stop()
        if (network) await network.stop()
        console.log('Teardown: Success')
      } catch (e) {
        console.error('Teardown error', e)
      }
    }, TIMEOUT)

    it(
      'Mesh-wide GraphQL Sync: A -> B -> Gateway',
      async () => {
        console.log('Inside Mesh-wide Sync test')
        const portA = peerA.getMappedPort(3000)
        const clientA = newWebSocketRpcSession<PublicApi>(`ws://127.0.0.1:${portA}/rpc`)

        const portB = peerB.getMappedPort(3000)
        const clientB = newWebSocketRpcSession<PublicApi>(`ws://127.0.0.1:${portB}/rpc`)

        const netAResult = await clientA.getNetworkClient(nodeCustodianToken)
        const netBResult = await clientB.getNetworkClient(nodeCustodianToken)

        if (!netAResult.success || !netBResult.success) {
          throw new Error('Failed to get network client')
        }

        const netA = netAResult.client
        const netB = netBResult.client

        // 1. Peer A and B
        console.log('Peering nodes A and B...')
        await netB.addPeer({
          name: 'peer-a.somebiz.local.io',
          endpoint: 'ws://peer-a:3000/rpc',
          domains: ['somebiz.local.io'],
        })
        await netA.addPeer({
          name: 'peer-b.somebiz.local.io',
          endpoint: 'ws://peer-b:3000/rpc',
          domains: ['somebiz.local.io'],
        })

        // Give it a moment for the handshake
        console.log('Waiting for handshake...')
        await new Promise((r) => setTimeout(r, 2000))

        // 2. A adds a GraphQL route
        console.log('Adding GraphQL route to A...')
        const dataAResult = await clientA.getDataChannelClient(dataCustodianToken)
        if (!dataAResult.success) throw new Error(`Failed to get data client: ${dataAResult.error}`)

        await dataAResult.client.addRoute({
          name: 'books-mesh',
          endpoint: 'http://books:8080/graphql',
          protocol: 'http:graphql',
        })

        console.log('Waiting for Gateway sync on Peer B...')
        let sawSync = false
        for (let i = 0; i < 30; i++) {
          if (peerBLogs.some((l) => l.includes('Gateway sync successful'))) {
            sawSync = true
            break
          }
          await new Promise((r) => setTimeout(r, 1000))
        }

        if (!sawSync) {
          console.log(
            'Peer B Logs during failure (count: ' + peerBLogs.length + '):',
            peerBLogs.join('\n')
          )
        }
        expect(sawSync).toBe(true)
      },
      TIMEOUT
    )
  })

  describe('Separate Auth', () => {
    let network: StartedNetwork
    let authA: AuthServiceContext
    let authB: AuthServiceContext
    let gateway: StartedTestContainer
    let peerA: StartedTestContainer
    let peerB: StartedTestContainer
    let books: StartedTestContainer
    const peerBLogs: string[] = []
    let nodeCustodianTokenA: string = ''
    let nodeCustodianTokenB: string = ''
    let dataCustodianTokenA: string = ''

    beforeAll(async () => {
      await buildImages()
      network = await new Network().start()

      // Start separate auth services
      authA = await startAuthService(network, 'auth-a', authImage, 'bootstrap-a')
      authB = await startAuthService(network, 'auth-b', authImage, 'bootstrap-b')

      const startContainer = async (
        name: string,
        alias: string,
        waitMsg: string,
        env: Record<string, string> = {},
        ports: number[] = []
      ) => {
        let image = orchestratorImage
        if (alias === 'gateway') image = gatewayImage
        if (alias === 'books') image = booksImage

        let container = new GenericContainer(image)
          .withNetwork(network)
          .withNetworkAliases(alias)
          .withWaitStrategy(Wait.forLogMessage(waitMsg))
          .withLogConsumer((stream: Readable) => {
            stream.pipe(process.stdout)
            stream.on('data', (data: Buffer | string) => {
              if (alias === 'peer-b') {
                peerBLogs.push(data.toString())
              }
            })
          })

        if (ports.length > 0) {
          ports.forEach((p) => (container = container.withExposedPorts(p)))
        }
        if (Object.keys(env).length > 0) {
          container = container.withEnvironment(env)
        }
        return await container.start()
      }

      gateway = await startContainer(
        'gateway',
        'gateway',
        'Catalyst server [gateway] listening',
        {
          CATALYST_NODE_ID: 'gateway',
          CATALYST_DOMAINS: 'somebiz.local.io',
          CATALYST_AUTH_ENDPOINT: authB.endpoint,
        },
        [4000]
      )

      const nodeEnv = (
        name: string,
        alias: string,
        authEndpoint: string,
        systemToken: string,
        gq: string = ''
      ) => ({
        PORT: '3000',
        CATALYST_NODE_ID: name,
        CATALYST_PEERING_ENDPOINT: `ws://${alias}:3000/rpc`,
        CATALYST_DOMAINS: 'somebiz.local.io',
        CATALYST_AUTH_ENDPOINT: authEndpoint,
        CATALYST_SYSTEM_TOKEN: systemToken,
        CATALYST_GQL_GATEWAY_ENDPOINT: gq,
      })

      peerA = await startContainer(
        'peer-a.somebiz.local.io',
        'peer-a',
        'Catalyst server [orchestrator] listening',
        nodeEnv('peer-a.somebiz.local.io', 'peer-a', authA.endpoint, authA.systemToken),
        [3000]
      )
      peerB = await startContainer(
        'peer-b.somebiz.local.io',
        'peer-b',
        'Catalyst server [orchestrator] listening',
        nodeEnv(
          'peer-b.somebiz.local.io',
          'peer-b',
          authB.endpoint,
          authB.systemToken,
          'ws://gateway:4000/api'
        ),
        [3000]
      )
      books = await startContainer('books', 'books', 'BOOKS_STARTED', {}, [8080])

      const authAHostUrl = `ws://${authA.container.getHost()}:${authA.container.getFirstMappedPort()}/rpc`
      const authBHostUrl = `ws://${authB.container.getHost()}:${authB.container.getFirstMappedPort()}/rpc`

      nodeCustodianTokenA = await mintNodeCustodianToken(
        authAHostUrl,
        authA.systemToken,
        'peer-a.somebiz.local.io',
        ['somebiz.local.io']
      )
      nodeCustodianTokenB = await mintNodeCustodianToken(
        authBHostUrl,
        authB.systemToken,
        'peer-b.somebiz.local.io',
        ['somebiz.local.io']
      )
      dataCustodianTokenA = await mintDataCustodianToken(
        authAHostUrl,
        authA.systemToken,
        'peer-a.somebiz.local.io',
        ['somebiz.local.io']
      )

      console.log('Containers started with separate auth servers')
    }, TIMEOUT)

    afterAll(async () => {
      console.log('Teardown: Starting...')
      try {
        if (peerA) await peerA.stop()
        if (peerB) await peerB.stop()
        if (books) await books.stop()
        if (gateway) await gateway.stop()
        if (authA) await authA.container.stop()
        if (authB) await authB.container.stop()
        if (network) await network.stop()
        console.log('Teardown: Success')
      } catch (e) {
        console.error('Teardown error', e)
      }
    }, TIMEOUT)

    it(
      'Gateway sync with separate auth servers',
      async () => {
        console.log('Inside Gateway sync test with separate auth')
        const portA = peerA.getMappedPort(3000)
        const clientA = newWebSocketRpcSession<PublicApi>(`ws://127.0.0.1:${portA}/rpc`)

        const portB = peerB.getMappedPort(3000)
        const clientB = newWebSocketRpcSession<PublicApi>(`ws://127.0.0.1:${portB}/rpc`)

        // Tokens should be unique
        expect(authA.systemToken).not.toBe(authB.systemToken)
        console.log('Confirmed: Tokens are unique per auth server')

        const netAResult = await clientA.getNetworkClient(nodeCustodianTokenA)
        const netBResult = await clientB.getNetworkClient(nodeCustodianTokenB)

        if (!netAResult.success || !netBResult.success) {
          throw new Error('Failed to get network client')
        }

        const netA = netAResult.client
        const netB = netBResult.client

        // Mint peer tokens for A <-> B peering
        console.log('Minting peer tokens for A <-> B...')
        const authAPort = authA.container.getMappedPort(5000)
        const authBPort = authB.container.getMappedPort(5000)

        const peerTokenBtoA = await mintPeerToken(
          `ws://127.0.0.1:${authAPort}/rpc`,
          authA.systemToken,
          'peer-b.somebiz.local.io',
          ['somebiz.local.io']
        )
        const peerTokenAtoB = await mintPeerToken(
          `ws://127.0.0.1:${authBPort}/rpc`,
          authB.systemToken,
          'peer-a.somebiz.local.io',
          ['somebiz.local.io']
        )

        // 1. Peer A and B
        console.log('Peering nodes A and B with separate auth...')
        await netB.addPeer({
          name: 'peer-a.somebiz.local.io',
          endpoint: 'ws://peer-a:3000/rpc',
          domains: ['somebiz.local.io'],
          peerToken: peerTokenBtoA,
        })
        await netA.addPeer({
          name: 'peer-b.somebiz.local.io',
          endpoint: 'ws://peer-b:3000/rpc',
          domains: ['somebiz.local.io'],
          peerToken: peerTokenAtoB,
        })

        // Give it a moment for the handshake
        console.log('Waiting for handshake...')
        await new Promise((r) => setTimeout(r, 2000))

        // 2. A adds a GraphQL route
        console.log('Adding GraphQL route to A...')
        const dataAResult = await clientA.getDataChannelClient(dataCustodianTokenA)
        if (!dataAResult.success) throw new Error(`Failed to get data client: ${dataAResult.error}`)

        await dataAResult.client.addRoute({
          name: 'books-mesh',
          endpoint: 'http://books:8080/graphql',
          protocol: 'http:graphql',
        })

        console.log('Waiting for Gateway sync on Peer B...')
        let sawSync = false
        for (let i = 0; i < 30; i++) {
          if (peerBLogs.some((l) => l.includes('Gateway sync successful'))) {
            sawSync = true
            break
          }
          await new Promise((r) => setTimeout(r, 1000))
        }

        if (!sawSync) {
          console.log(
            'Peer B Logs during failure (count: ' + peerBLogs.length + '):',
            peerBLogs.join('\n')
          )
        }
        expect(sawSync).toBe(true)
        console.log('Gateway sync successful with separate auth servers')
      },
      TIMEOUT
    )
  })
})
