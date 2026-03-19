/**
 * OTEL metrics for the video streaming service.
 *
 * Naming follows OTEL semconv `naming.md`:
 * - Dot-separated lowercase namespace (`video.*`)
 * - No `.total` suffix on counters
 * - Counters use plural names; UpDownCounters use singular
 * - Duration histograms use `s` (seconds) per UCUM
 * - Attribute names use snake_case (application-specific)
 */

import { getMeter } from '@catalyst/telemetry'
import { DURATION_BUCKETS } from '@catalyst/telemetry'
import type { Counter, Histogram, UpDownCounter } from '@opentelemetry/api'

export interface VideoMetrics {
  // Stream lifecycle
  streamActive: UpDownCounter
  streamPublishes: Counter
  streamDisconnects: Counter
  streamDuration: Histogram
  // Auth
  authRequests: Counter
  authFailures: Counter
  authDuration: Histogram
  // MediaMTX health
  mediamtxRestarts: Counter
  mediamtxCrashes: Counter
  mediamtxRunning: UpDownCounter
  // Relay
  relayActive: UpDownCounter
  relaySetupDuration: Histogram
  relaySetups: Counter
  // Route ops
  routeOperations: Counter
}

export function createVideoMetrics(): VideoMetrics {
  const meter = getMeter('@catalyst/video')

  return {
    // Stream lifecycle
    streamActive: meter.createUpDownCounter('video.stream.active', {
      description: 'Currently active streams',
      unit: '{stream}',
    }),
    streamPublishes: meter.createCounter('video.stream.publishes', {
      description: 'Total publish events',
      unit: '{publish}',
    }),
    streamDisconnects: meter.createCounter('video.stream.disconnects', {
      description: 'Total disconnect events',
      unit: '{disconnect}',
    }),
    streamDuration: meter.createHistogram('video.stream.duration', {
      description: 'Stream session duration',
      unit: 's',
      advice: { explicitBucketBoundaries: DURATION_BUCKETS },
    }),

    // Auth
    authRequests: meter.createCounter('video.auth.requests', {
      description: 'Auth hook invocations',
      unit: '{request}',
    }),
    authFailures: meter.createCounter('video.auth.failures', {
      description: 'Auth failures (denied + errors)',
      unit: '{failure}',
    }),
    authDuration: meter.createHistogram('video.auth.duration', {
      description: 'Auth evaluation latency',
      unit: 's',
      advice: { explicitBucketBoundaries: DURATION_BUCKETS },
    }),

    // MediaMTX health
    mediamtxRestarts: meter.createCounter('video.mediamtx.restarts', {
      description: 'Supervised process restarts',
      unit: '{restart}',
    }),
    mediamtxCrashes: meter.createCounter('video.mediamtx.crashes', {
      description: 'Unexpected process exits',
      unit: '{crash}',
    }),
    mediamtxRunning: meter.createUpDownCounter('video.mediamtx.running', {
      description: 'MediaMTX process state (1=up, 0=down)',
      unit: '{process}',
    }),

    // Relay
    relayActive: meter.createUpDownCounter('video.relay.active', {
      description: 'Active relay paths',
      unit: '{relay}',
    }),
    relaySetupDuration: meter.createHistogram('video.relay.setup.duration', {
      description: 'Relay path setup latency',
      unit: 's',
      advice: { explicitBucketBoundaries: DURATION_BUCKETS },
    }),
    relaySetups: meter.createCounter('video.relay.setups', {
      description: 'Relay setup attempts',
      unit: '{setup}',
    }),

    // Route ops
    routeOperations: meter.createCounter('video.route.operations', {
      description: 'Route create/delete operations',
      unit: '{operation}',
    }),
  }
}
