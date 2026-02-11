import * as grpc from '@grpc/grpc-js'
import type { ServiceTelemetry } from '@catalyst/telemetry'
import { TelemetryBuilder } from '@catalyst/telemetry'
import type { SnapshotCache, XdsSnapshot } from './snapshot-cache.js'
import {
  LISTENER_TYPE_URL,
  CLUSTER_TYPE_URL,
  encodeListener,
  encodeTcpProxyListener,
  encodeCluster,
  encodeDiscoveryResponse,
  decodeDiscoveryRequest,
} from './proto-encoding.js'
import { isTcpProxyListener } from './resources.js'

// ---------------------------------------------------------------------------
// ADS service definition for @grpc/grpc-js
// ---------------------------------------------------------------------------

const ADS_SERVICE_PATH =
  '/envoy.service.discovery.v3.AggregatedDiscoveryService/StreamAggregatedResources'

const adsServiceDefinition: grpc.ServiceDefinition = {
  StreamAggregatedResources: {
    path: ADS_SERVICE_PATH,
    requestStream: true,
    responseStream: true,
    requestSerialize: (value: Buffer) => value,
    requestDeserialize: (buffer: Buffer) => buffer,
    responseSerialize: (value: Buffer) => value,
    responseDeserialize: (buffer: Buffer) => buffer,
  },
}

// ---------------------------------------------------------------------------
// XdsControlPlane — gRPC ADS server backed by the snapshot cache
// ---------------------------------------------------------------------------

export interface XdsControlPlaneOptions {
  /** Port for the gRPC ADS server. */
  port: number
  /** Bind address (default: 0.0.0.0). */
  bindAddress?: string
  /** Snapshot cache to watch for changes. */
  snapshotCache: SnapshotCache
  /** Telemetry for logging. */
  telemetry?: ServiceTelemetry
}

export class XdsControlPlane {
  private readonly server: grpc.Server
  private readonly port: number
  private readonly bindAddress: string
  private readonly cache: SnapshotCache
  private readonly logger: ServiceTelemetry['logger']
  private started = false
  private nonceCounter = 0

  constructor(options: XdsControlPlaneOptions) {
    this.port = options.port
    this.bindAddress = options.bindAddress ?? '0.0.0.0'
    this.cache = options.snapshotCache
    const telemetry = options.telemetry ?? TelemetryBuilder.noop('envoy')
    this.logger = telemetry.logger.getChild('xds')

    this.server = new grpc.Server()
    this.server.addService(adsServiceDefinition, {
      StreamAggregatedResources: this.handleStream.bind(this),
    })
  }

  /**
   * Start the gRPC server and begin accepting ADS connections.
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.bindAsync(
        `${this.bindAddress}:${this.port}`,
        grpc.ServerCredentials.createInsecure(),
        (err, boundPort) => {
          if (err) {
            reject(err)
            return
          }
          this.started = true
          this.logger.info`xDS ADS server listening on ${this.bindAddress}:${boundPort}`
          resolve()
        }
      )
    })
  }

  /**
   * Gracefully shut down the gRPC server.
   */
  async shutdown(): Promise<void> {
    if (!this.started) return
    return new Promise((resolve) => {
      this.server.tryShutdown(() => {
        this.started = false
        this.logger.info`xDS ADS server stopped`
        resolve()
      })
    })
  }

  /**
   * Handle a single ADS bidirectional stream from an Envoy proxy.
   *
   * Protocol (SotW ADS):
   * 1. Client subscribes to CDS, server sends CDS response
   * 2. Client ACKs CDS, subscribes to LDS, server sends LDS response
   * 3. On snapshot changes, send updates for all subscribed types
   *
   * Responses are only sent for types the client has subscribed to.
   * This ensures Envoy doesn't discard unsolicited responses.
   */
  private handleStream(call: grpc.ServerDuplexStream<Buffer, Buffer>): void {
    this.logger.info`New ADS stream connected`

    // Track subscribed types, sent versions, and acknowledged versions
    const subscribedTypes = new Set<string>()
    const sentVersions = new Map<string, string>()
    const ackedVersions = new Map<string, string>()
    let latestSnapshot: XdsSnapshot | undefined

    /** Send snapshot resources for subscribed types that haven't been sent at this version. */
    const sendSubscribed = (): void => {
      if (!latestSnapshot) return
      this.sendSnapshotForTypes(call, latestSnapshot, subscribedTypes, sentVersions)
    }

    // Watch for snapshot changes — send updates for subscribed types.
    // The cache uses BehaviorSubject semantics: if a snapshot already exists,
    // the callback fires immediately with the current value, so late-connecting
    // streams always receive the latest config.
    const unwatch = this.cache.watch((snapshot) => {
      latestSnapshot = snapshot
      sendSubscribed()
    })

    // Process incoming messages (subscribes, ACKs, NACKs)
    call.on('data', (buffer: Buffer) => {
      try {
        const request = decodeDiscoveryRequest(buffer)

        if (request.version_info) {
          // ACK — client confirmed it received this version
          ackedVersions.set(request.type_url, request.version_info)
          this.logger.info`ACK received for ${request.type_url} v${request.version_info}`
        } else if (request.response_nonce) {
          // NACK — client rejected the last response (version_info empty but nonce set)
          this.logger.warn`NACK received for ${request.type_url} nonce=${request.response_nonce}`
        } else {
          // Initial subscribe — send pending resources for this type
          this.logger.info`Subscribe request for ${request.type_url}`
          subscribedTypes.add(request.type_url)
          sendSubscribed()
        }
      } catch (err) {
        this.logger.error`Failed to decode DiscoveryRequest: ${err}`
      }
    })

    call.on('end', () => {
      this.logger.info`ADS stream disconnected`
      unwatch()
      call.end()
    })

    call.on('error', (err) => {
      // CANCELLED is normal when Envoy disconnects
      if ((err as grpc.ServiceError).code !== grpc.status.CANCELLED) {
        this.logger.error`ADS stream error: ${err}`
      }
      unwatch()
    })
  }

  /**
   * Send snapshot resources for subscribed types that haven't been sent at this version.
   * CDS is sent before LDS to ensure clusters exist before listeners reference them.
   */
  private sendSnapshotForTypes(
    call: grpc.ServerDuplexStream<Buffer, Buffer>,
    snapshot: XdsSnapshot,
    subscribedTypes: Set<string>,
    sentVersions: Map<string, string>
  ): void {
    // CDS first (only if subscribed and not already sent at this version)
    if (
      subscribedTypes.has(CLUSTER_TYPE_URL) &&
      sentVersions.get(CLUSTER_TYPE_URL) !== snapshot.version
    ) {
      const cdsResources = snapshot.clusters.map((c) => encodeCluster(c))
      const cdsResponse = encodeDiscoveryResponse({
        version_info: snapshot.version,
        resources: cdsResources,
        type_url: CLUSTER_TYPE_URL,
        nonce: String(++this.nonceCounter),
      })
      call.write(cdsResponse)
      sentVersions.set(CLUSTER_TYPE_URL, snapshot.version)
      this.logger.info`Sent CDS v${snapshot.version} (${snapshot.clusters.length} clusters)`
    }

    // Then LDS (only if subscribed and not already sent at this version)
    if (
      subscribedTypes.has(LISTENER_TYPE_URL) &&
      sentVersions.get(LISTENER_TYPE_URL) !== snapshot.version
    ) {
      const ldsResources = snapshot.listeners.map((l) =>
        isTcpProxyListener(l) ? encodeTcpProxyListener(l) : encodeListener(l)
      )
      const ldsResponse = encodeDiscoveryResponse({
        version_info: snapshot.version,
        resources: ldsResources,
        type_url: LISTENER_TYPE_URL,
        nonce: String(++this.nonceCounter),
      })
      call.write(ldsResponse)
      sentVersions.set(LISTENER_TYPE_URL, snapshot.version)
      this.logger.info`Sent LDS v${snapshot.version} (${snapshot.listeners.length} listeners)`
    }
  }
}
