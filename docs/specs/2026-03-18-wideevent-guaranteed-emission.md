# WideEvent Guaranteed Emission

## Problem

WideEvent accumulates telemetry fields throughout a unit of work and emits them as a single structured log record. If an exception is thrown between `new WideEvent()` and `.emit()`, all accumulated telemetry is silently lost. TypeScript has no syntax-level guarantee that `.emit()` will be called.

Audit found: 21 WideEvent sites total — 8 protected (try/finally), 11 unprotected, 1 missing `.emit()` entirely (bug).

## Solution

Add a `withWideEvent` wrapper to `@catalyst/telemetry` that guarantees emission via `try/finally`. Migrate all 21 existing sites to use it.

```ts
export async function withWideEvent<T>(
  eventName: string,
  logger: Logger,
  fn: (event: WideEvent) => Promise<T>
): Promise<T> {
  const event = new WideEvent(eventName, logger)
  try {
    return await fn(event)
  } catch (err) {
    event.setError(err)
    throw err
  } finally {
    event.emit()
  }
}
```

### Behaviors

- `emit()` is already idempotent — safe if `fn` calls it early
- `setError()` marks outcome as `'failure'` before re-throwing
- Fire-and-forget callers wrap the call in their own `try/catch`
- `WideEvent` class stays exported (non-breaking), but all internal usage migrates

### Migration pattern

Before:

```ts
const event = new WideEvent('op.name', logger)
event.set({ field: value })
// ... work that could throw ...
event.emit()
```

After:

```ts
await withWideEvent('op.name', logger, async (event) => {
  event.set({ field: value })
  // ... work that could throw ...
})
```

## Sites to migrate

| File                                              | Event name                            | Current status     |
| ------------------------------------------------- | ------------------------------------- | ------------------ |
| `packages/telemetry/src/middleware/wide-event.ts` | `http.request`                        | Protected          |
| `apps/orchestrator/src/v2/bus.ts`                 | `orchestrator.action`                 | Unprotected        |
| `apps/orchestrator/src/v2/bus.ts`                 | `orchestrator.peer_sync`              | Unprotected        |
| `apps/orchestrator/src/v2/bus.ts`                 | `orchestrator.route_propagation`      | Missing emit (bug) |
| `apps/orchestrator/src/v2/bus.ts`                 | `orchestrator.gateway_sync`           | Protected          |
| `apps/orchestrator/src/v2/bus.ts`                 | `orchestrator.envoy_sync`             | Protected          |
| `apps/orchestrator/src/v2/rpc.ts`                 | `orchestrator.rpc_auth` (network)     | Unprotected        |
| `apps/orchestrator/src/v2/rpc.ts`                 | `orchestrator.rpc_auth` (datachannel) | Unprotected        |
| `apps/orchestrator/src/v2/rpc.ts`                 | `orchestrator.rpc_auth` (ibgp)        | Unprotected        |
| `apps/orchestrator/src/v2/ws-transport.ts`        | `orchestrator.peer_open`              | Unprotected        |
| `apps/orchestrator/src/v2/http-transport.ts`      | `orchestrator.peer_open`              | Unprotected        |
| `apps/orchestrator/src/v2/http-transport.ts`      | `orchestrator.peer_close`             | Unprotected        |
| `apps/orchestrator/src/v2/catalyst-service.ts`    | `orchestrator.token_mint`             | Protected          |
| `apps/orchestrator/src/v2/catalyst-service.ts`    | `orchestrator.token_refresh`          | Protected          |
| `apps/orchestrator/src/v2/compaction.ts`          | `orchestrator.compaction`             | Protected          |
| `apps/orchestrator/src/v2/service.ts`             | `orchestrator.auto_dial`              | Unprotected        |
| `apps/orchestrator/src/v1/orchestrator.ts`        | `orchestrator.action` (v1)            | Unprotected        |
| `apps/envoy/src/rpc/server.ts`                    | `envoy.route_update`                  | Protected          |
| `apps/gateway/src/graphql/server.ts`              | `gateway.schema_reload`               | Protected          |

## Testing

- Unit test for `withWideEvent`: verifies emit on success, emit on error with `setError`, and that the error is re-thrown
- Existing tests continue to pass (behavioral no-op for already-protected sites)
