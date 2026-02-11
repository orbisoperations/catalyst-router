import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import * as grpc from '@grpc/grpc-js'
import { createSnapshotCache } from '../src/xds/snapshot-cache.js'
import { XdsControlPlane } from '../src/xds/control-plane.js'
import { buildIngressListener, buildLocalCluster } from '../src/xds/resources.js'
import {
  LISTENER_TYPE_URL,
  CLUSTER_TYPE_URL,
  getProtoRoot,
  encodeDiscoveryResponse,
} from '../src/xds/proto-encoding.js'

const ADS_SERVICE_PATH =
  '/envoy.service.discovery.v3.AggregatedDiscoveryService/StreamAggregatedResources'

/**
 * Create a raw gRPC client for the ADS service.
 * Uses @grpc/grpc-js directly to simulate an Envoy proxy connecting.
 */
function createAdsClient(port: number): grpc.Client {
  return new grpc.Client(`localhost:${port}`, grpc.credentials.createInsecure())
}

/**
 * Open a bidirectional ADS stream and collect responses.
 */
function openAdsStream(client: grpc.Client): {
  stream: grpc.ClientDuplexStream<Buffer, Buffer>
  responses: Array<{
    version_info: string
    type_url: string
    nonce: string
    resourceCount: number
  }>
  waitForResponses: (count: number, timeoutMs?: number) => Promise<void>
} {
  const responses: Array<{
    version_info: string
    type_url: string
    nonce: string
    resourceCount: number
  }> = []

  const stream = client.makeBidiStreamRequest(
    ADS_SERVICE_PATH,
    (v: Buffer) => v,
    (v: Buffer) => v
  )

  const root = getProtoRoot()
  const ResponseType = root.lookupType('envoy.service.discovery.v3.DiscoveryResponse')

  stream.on('data', (buffer: Buffer) => {
    const msg = ResponseType.decode(buffer)
    const obj = ResponseType.toObject(msg, { defaults: true, arrays: true }) as {
      version_info: string
      type_url: string
      nonce: string
      resources: unknown[]
    }
    responses.push({
      version_info: obj.version_info,
      type_url: obj.type_url,
      nonce: obj.nonce,
      resourceCount: obj.resources.length,
    })
  })

  function waitForResponses(count: number, timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      const start = Date.now()
      const check = () => {
        if (responses.length >= count) {
          resolve()
          return
        }
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Timed out waiting for ${count} responses (got ${responses.length})`))
          return
        }
        setTimeout(check, 50)
      }
      check()
    })
  }

  return { stream, responses, waitForResponses }
}

describe('ADS gRPC Control Plane', () => {
  let controlPlane: XdsControlPlane
  let port: number
  const cache = createSnapshotCache()

  beforeAll(async () => {
    // Use a random available port
    const tempServer = Bun.serve({ fetch: () => new Response(''), port: 0 })
    port = tempServer.port
    tempServer.stop()

    controlPlane = new XdsControlPlane({
      port,
      snapshotCache: cache,
    })
    await controlPlane.start()
  }, 10000)

  afterAll(async () => {
    await controlPlane?.shutdown()
  })

  it('sends CDS and LDS on initial connect when snapshot exists', async () => {
    // Push a snapshot before connecting
    cache.setSnapshot({
      version: '1',
      listeners: [
        buildIngressListener({
          channelName: 'books-api',
          port: 10001,
          bindAddress: '0.0.0.0',
        }),
      ],
      clusters: [
        buildLocalCluster({
          channelName: 'books-api',
          address: '127.0.0.1',
          port: 8080,
        }),
      ],
    })

    const client = createAdsClient(port)
    const { stream, responses, waitForResponses } = openAdsStream(client)

    try {
      // Should receive 2 responses: CDS first, then LDS
      await waitForResponses(2)

      expect(responses).toHaveLength(2)

      // First response: CDS
      expect(responses[0].type_url).toBe(CLUSTER_TYPE_URL)
      expect(responses[0].version_info).toBe('1')
      expect(responses[0].resourceCount).toBe(1)

      // Second response: LDS
      expect(responses[1].type_url).toBe(LISTENER_TYPE_URL)
      expect(responses[1].version_info).toBe('1')
      expect(responses[1].resourceCount).toBe(1)
    } finally {
      stream.end()
      client.close()
    }
  })

  it('pushes new snapshot when cache updates', async () => {
    const client = createAdsClient(port)
    const { stream, responses, waitForResponses } = openAdsStream(client)

    try {
      // Wait for the initial snapshot (from previous test)
      await waitForResponses(2)
      const initialCount = responses.length

      // Push a new snapshot with an additional route
      cache.setSnapshot({
        version: '2',
        listeners: [
          buildIngressListener({
            channelName: 'books-api',
            port: 10001,
            bindAddress: '0.0.0.0',
          }),
          buildIngressListener({
            channelName: 'movies-api',
            port: 10002,
            bindAddress: '0.0.0.0',
          }),
        ],
        clusters: [
          buildLocalCluster({
            channelName: 'books-api',
            address: '127.0.0.1',
            port: 8080,
          }),
          buildLocalCluster({
            channelName: 'movies-api',
            address: '127.0.0.1',
            port: 8081,
          }),
        ],
      })

      // Wait for 2 more responses (CDS v2 + LDS v2)
      await waitForResponses(initialCount + 2)

      const v2Responses = responses.slice(initialCount)
      expect(v2Responses).toHaveLength(2)

      // CDS v2 with 2 clusters
      expect(v2Responses[0].type_url).toBe(CLUSTER_TYPE_URL)
      expect(v2Responses[0].version_info).toBe('2')
      expect(v2Responses[0].resourceCount).toBe(2)

      // LDS v2 with 2 listeners
      expect(v2Responses[1].type_url).toBe(LISTENER_TYPE_URL)
      expect(v2Responses[1].version_info).toBe('2')
      expect(v2Responses[1].resourceCount).toBe(2)
    } finally {
      stream.end()
      client.close()
    }
  })

  it('handles stream disconnect gracefully', async () => {
    const client = createAdsClient(port)
    const { stream } = openAdsStream(client)

    // Wait for initial data before closing
    await new Promise((r) => setTimeout(r, 200))

    // Close the stream — should not crash the server
    stream.end()
    client.close()

    // Wait for cleanup, then verify server is still running
    await new Promise((r) => setTimeout(r, 500))

    const client2 = createAdsClient(port)
    try {
      const { stream: stream2, responses, waitForResponses } = openAdsStream(client2)

      try {
        await waitForResponses(2)
        expect(responses.length).toBeGreaterThanOrEqual(2)
      } finally {
        stream2.end()
      }
    } finally {
      client2.close()
    }
  })

  it('decodes and encodes proto messages correctly', () => {
    const root = getProtoRoot()

    // Test DiscoveryResponse encoding
    const responseBytes = encodeDiscoveryResponse({
      version_info: 'test-v1',
      resources: [],
      type_url: CLUSTER_TYPE_URL,
      nonce: 'nonce-1',
    })

    // Decode it back
    const ResponseType = root.lookupType('envoy.service.discovery.v3.DiscoveryResponse')
    const decoded = ResponseType.toObject(ResponseType.decode(responseBytes), {
      defaults: true,
    }) as {
      version_info: string
      type_url: string
      nonce: string
    }
    expect(decoded.version_info).toBe('test-v1')
    expect(decoded.type_url).toBe(CLUSTER_TYPE_URL)
    expect(decoded.nonce).toBe('nonce-1')
  })
})
