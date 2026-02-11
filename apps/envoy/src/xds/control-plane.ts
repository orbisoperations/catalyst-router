import * as grpc from '@grpc/grpc-js'
import type { ServiceTelemetry } from '@catalyst/telemetry'
import { TelemetryBuilder } from '@catalyst/telemetry'
import type { SnapshotCache, XdsSnapshot } from './snapshot-cache.js'
import {
  LISTENER_TYPE_URL,
  CLUSTER_TYPE_URL,
  encodeListener,
  encodeCluster,
  encodeDiscoveryResponse,
  decodeDiscoveryRequest,
} from './proto-encoding.js'

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
// Nonce generation
// ---------------------------------------------------------------------------

let nonceCounter = 0
function nextNonce(): string {
  return String(++nonceCounter)
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
   * Protocol:
   * 1. On connect, send the current snapshot (CDS first, then LDS)
   * 2. Watch for snapshot changes and push updates
   * 3. Process incoming ACKs/NACKs from Envoy
   */
  private handleStream(call: grpc.ServerDuplexStream<Buffer, Buffer>): void {
    this.logger.info`New ADS stream connected`

    // Track acknowledged versions per type URL
    const ackedVersions = new Map<string, string>()

    // Send current snapshot immediately
    const current = this.cache.getSnapshot()
    if (current) {
      this.sendSnapshot(call, current)
    }

    // Watch for changes
    const unwatch = this.cache.watch((snapshot) => {
      this.sendSnapshot(call, snapshot)
    })

    // Process incoming messages (ACKs and NACKs)
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
          // Initial request — client subscribing to a resource type
          this.logger.info`Subscribe request for ${request.type_url}`
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
   * Send a complete snapshot to the connected Envoy.
   * CDS is sent first to ensure clusters exist before listeners reference them.
   */
  private sendSnapshot(call: grpc.ServerDuplexStream<Buffer, Buffer>, snapshot: XdsSnapshot): void {
    // CDS first
    if (snapshot.clusters.length > 0) {
      const cdsResources = snapshot.clusters.map((c) => encodeCluster(c))
      const cdsResponse = encodeDiscoveryResponse({
        version_info: snapshot.version,
        resources: cdsResources,
        type_url: CLUSTER_TYPE_URL,
        nonce: nextNonce(),
      })
      call.write(cdsResponse)
      this.logger.info`Sent CDS v${snapshot.version} (${snapshot.clusters.length} clusters)`
    }

    // Then LDS
    if (snapshot.listeners.length > 0) {
      const ldsResources = snapshot.listeners.map((l) => encodeListener(l))
      const ldsResponse = encodeDiscoveryResponse({
        version_info: snapshot.version,
        resources: ldsResources,
        type_url: LISTENER_TYPE_URL,
        nonce: nextNonce(),
      })
      call.write(ldsResponse)
      this.logger.info`Sent LDS v${snapshot.version} (${snapshot.listeners.length} listeners)`
    }
  }
}
