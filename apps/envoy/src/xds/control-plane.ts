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

    // Track subscribed types and sent versions per-stream
    const subscribedTypes = new Set<string>()
    const sentVersions = new Map<string, string>()
    let latestSnapshot: XdsSnapshot | undefined = this.cache.getSnapshot()
    let streamNonce = 0
    const nextNonce = (): string => String(++streamNonce)

    /** Send snapshot resources for subscribed types that haven't been sent at this version. */
    const sendSubscribed = (): void => {
      if (!latestSnapshot) return
      this.sendSnapshotForTypes(call, latestSnapshot, subscribedTypes, sentVersions, nextNonce)
    }

    // Watch for snapshot changes — send updates for subscribed types
    const unwatch = this.cache.watch((snapshot) => {
      latestSnapshot = snapshot
      sendSubscribed()
    })

    // Process incoming messages (subscribes, ACKs, NACKs)
    //
    // Per the xDS SotW protocol:
    // - Initial subscribe: empty version_info, empty response_nonce
    // - ACK: version_info matches last sent version, response_nonce matches, no error_detail
    // - NACK: version_info is last *accepted* version, response_nonce matches, error_detail present
    //
    // Every request with a type_url is an implicit (re-)subscription for that type.
    call.on('data', (buffer: Buffer) => {
      try {
        const request = decodeDiscoveryRequest(buffer)
        const typeUrl = request.type_url

        // Every DiscoveryRequest with a type_url is a subscription for that type
        if (typeUrl) {
          subscribedTypes.add(typeUrl)
        }

        if (!request.version_info && !request.response_nonce) {
          // Initial subscribe — no version yet, send current snapshot
          this.logger.info`Subscribe request for ${typeUrl}`
          sendSubscribed()
        } else if (request.error_detail && request.error_detail.code !== 0) {
          // NACK — client rejected the response (error_detail present with non-zero code)
          this.logger
            .warn`NACK received for ${typeUrl} nonce=${request.response_nonce} error=${request.error_detail.message}`
        } else {
          // ACK — client confirmed it applied this version
          this.logger.info`ACK received for ${typeUrl} v${request.version_info}`
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
    sentVersions: Map<string, string>,
    nextNonce: () => string
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
        nonce: nextNonce(),
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
        nonce: nextNonce(),
      })
      call.write(ldsResponse)
      sentVersions.set(LISTENER_TYPE_URL, snapshot.version)
      this.logger.info`Sent LDS v${snapshot.version} (${snapshot.listeners.length} listeners)`
    }
  }
}
