# Structured Logging & Wide Events Design

**Date:** 2026-03-09
**Task:** [Node Logs](https://www.notion.so/31947ad1da7980c581d2e93b1f5a4674)
**Epic:** [Instrumentation & Logs](https://www.notion.so/31847ad1da7980d494d2d65df833deb0)

## Problem

All logging across Catalyst Router services uses LogTape template literals:

```typescript
this.logger.info`Dispatching action: ${sentAction.action}`
```

Values are baked into the message string and are not queryable as structured fields. The OTLP pipeline (LogTape -> OTEL Collector -> Loki) already forwards `record.properties` as log record attributes, but nobody is using properties.

Operators cannot answer questions like:

- "Why did peer node-b disconnect from node-a?"
- "What routes were advertised in the last BGP UPDATE?"
- "How long does route convergence take after a peer connects?"

## Approach

Combine two complementary patterns:

1. **Wide events** — One canonical structured event per unit of work per service, emitted at completion with 20-50+ fields. Primary debugging tool.
2. **Structured state transition logs** — Individual log lines for important state changes (peer connect/disconnect, route advertise/withdraw), using string + properties pattern. Provide timeline granularity within a unit of work.

Both use LogTape's `logger.info("message {key}", { key: value })` API, which keeps the human-readable message AND sends all properties as discrete OTEL log record attributes.

References:

- [Wide Events / Canonical Log Lines](https://loggingsucks.com)
- [LogTape Structured Logging](https://logtape.org/manual/struct)
- [OTel Log Data Model](https://opentelemetry.io/docs/specs/otel/logs/data-model/)

## Design

### WideEvent builder

New class in `@catalyst/telemetry` that accumulates fields throughout a unit of work and emits once at completion.

```typescript
// packages/telemetry/src/wide-event.ts

class WideEvent {
  private fields: Record<string, unknown> = {}
  private logger: Logger

  constructor(eventName: string, logger: Logger) {
    this.set('event.name', eventName)
    this.set('event.start_time', Date.now())
  }

  /** Add one or more fields */
  set(key: string, value: unknown): this
  set(fields: Record<string, unknown>): this

  /** Mark the event as errored */
  setError(error: unknown): this {
    // Sets error.type, error.message, event.outcome = "failure"
  }

  /** Emit the canonical wide event log record */
  emit(): void {
    // Sets event.duration_ms, event.outcome (default "success")
    // Emits via logger.info("{eventName} completed", this.fields)
  }
}
```

### Integration: HTTP services (gateway, auth)

Hono middleware creates WideEvent, enriches with request context, emits on response:

```typescript
// packages/telemetry/src/middleware/wide-event.ts

export function wideEventMiddleware() {
  return async (c: Context, next: Next) => {
    const event = new WideEvent('http.request', logger)
    event.set({
      'http.method': c.req.method,
      'http.route': c.req.routePath,
      'http.url': c.req.path,
    })
    c.set('wideEvent', event)

    try {
      await next()
      event.set('http.status_code', c.res.status)
      if (c.res.status >= 400) event.set('event.outcome', 'failure')
    } catch (err) {
      event.setError(err)
      throw err
    } finally {
      event.emit()
    }
  }
}
```

Handlers enrich inline: `c.get("wideEvent").set({ "auth.subject": subject })`

### Integration: Orchestrator actions

Wide event wraps each action dispatch:

```typescript
const event = new WideEvent('orchestrator.action', this.logger)
event.set({
  'action.type': action.action,
  'peer.name': peer?.name,
  'node.name': this.config.node.name,
})

try {
  const result = await this.executeAction(action)
  event.set({ 'action.routes_affected': result.routeCount })
} catch (err) {
  event.setError(err)
} finally {
  event.emit()
}
```

### Integration: Envoy xDS

Wide event per snapshot push:

```typescript
const event = new WideEvent('xds.snapshot.push', this.logger)
event.set({
  'xds.resource_type': typeUrl,
  'xds.version': snapshot.version,
  'xds.resource_count': resources.length,
})
```

### Integration: Node

Wide event per RPC call:

```typescript
const event = new WideEvent('rpc.call', logger)
event.set({ 'rpc.method': method })
```

### Template literal migration

Every template literal log becomes string + properties:

```typescript
// Before
this.logger.info`Dispatching action: ${sentAction.action}`

// After
this.logger.info('Dispatching action: {action}', {
  'event.name': 'orchestrator.action.dispatched',
  action: sentAction.action,
})
```

Logs that are redundant with the wide event (e.g., "received request") are removed rather than converted.

## Field conventions

- **`event.name`**: dot-separated, verb-last: `peer.session.opened`, `route.advertised`, `gateway.reloaded`
- **OTel semconv fields**: `http.method`, `http.status_code`, `http.route`, `error.type`, `error.message`
- **Domain fields**: `peer.*`, `route.*`, `gateway.*`, `auth.*`, `xds.*`
- **Common wide event fields**: `event.name`, `event.outcome`, `event.duration_ms`, `event.start_time`, `node.name`

## Wide event catalog

| Service      | event.name               | Key fields                                                                 |
| ------------ | ------------------------ | -------------------------------------------------------------------------- |
| orchestrator | `orchestrator.action`    | `action.type`, `peer.name`, `route.name`, `route.count`, `route.protocol`  |
| orchestrator | `peer.session.lifecycle` | `peer.name`, `peer.endpoint`, `peer.hold_time`, `session.routes_exchanged` |
| gateway      | `gateway.reload`         | `gateway.service_count`, `gateway.schema_hash`                             |
| gateway      | `http.request`           | `http.method`, `http.route`, `http.status_code`                            |
| auth         | `http.request`           | `auth.operation`, `auth.token_type`, `auth.subject`                        |
| envoy        | `xds.snapshot.push`      | `xds.resource_type`, `xds.version`, `xds.resource_count`, `xds.client_id`  |
| node         | `rpc.call`               | `rpc.method`, `rpc.status`                                                 |

## State transition log catalog

| event.name               | Service      | When                                        |
| ------------------------ | ------------ | ------------------------------------------- |
| `peer.session.opened`    | orchestrator | Peer connected                              |
| `peer.session.closed`    | orchestrator | Peer disconnected (includes `close.reason`) |
| `route.advertised`       | orchestrator | Route pushed to peer                        |
| `route.withdrawn`        | orchestrator | Route removed from peer                     |
| `route.installed`        | orchestrator | Route added to local table                  |
| `gateway.reload.started` | gateway      | Schema reload triggered                     |
| `gateway.reload.failed`  | gateway      | Schema reload failed                        |
| `token.minted`           | auth         | New JWT issued                              |
| `token.refresh.failed`   | auth         | Token refresh failed                        |
| `xds.client.subscribed`  | envoy        | New xDS subscription                        |
| `xds.client.acked`       | envoy        | Client ACK received                         |

## Service order

1. `@catalyst/telemetry` — WideEvent class, HTTP middleware, exports
2. orchestrator — highest value, most complex
3. gateway — reload events + HTTP
4. auth — token operations
5. envoy — xDS lifecycle
6. node — RPC server

## Out of scope

- Spans / traces (separate ticket)
- Metrics (separate ticket, see RED Metrics tasks)
- Video service (does not exist yet)
- CLI / rpi-config (no wide events needed)
- Loki / collector config changes (pipeline already works)
