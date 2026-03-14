# Structured Logging & Wide Events Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace all template-literal logging with structured string+properties calls across all Catalyst Router services, and add wide-event canonical log records for each unit of work.

**Architecture:** A `WideEvent` builder class in `@catalyst/telemetry` accumulates structured fields throughout a unit of work and emits a single canonical log record at completion. HTTP services use Hono middleware. Orchestrator wraps action dispatch. Envoy wraps xDS operations. All remaining template literal logs are converted to `logger.info("msg {key}", { ...props })` with `event.name` fields.

**Tech Stack:** LogTape 0.12.0, OpenTelemetry SDK, Vitest, Hono

**Design doc:** `docs/plans/2026-03-09-structured-logging-wide-events-design.md`

---

## Task 1: WideEvent class

**Files:**

- Create: `packages/telemetry/src/wide-event.ts`
- Modify: `packages/telemetry/src/index.ts`
- Create: `packages/telemetry/tests/wide-event.unit.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/telemetry/tests/wide-event.unit.test.ts
import { describe, it, expect, vi } from 'vitest'
import { WideEvent } from '../src/wide-event.js'

function createSpyLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    getChild: vi.fn(),
  }
}

describe('WideEvent', () => {
  it('emits a single log record with all accumulated fields', () => {
    const logger = createSpyLogger()
    const event = new WideEvent('orchestrator.action', logger as any)
    event.set('action.type', 'LocalPeerCreate')
    event.set({ 'peer.name': 'node-b', 'node.name': 'node-a' })
    event.emit()

    expect(logger.info).toHaveBeenCalledTimes(1)
    const [message, props] = logger.info.mock.calls[0]
    expect(message).toContain('orchestrator.action')
    expect(props).toMatchObject({
      'event.name': 'orchestrator.action',
      'action.type': 'LocalPeerCreate',
      'peer.name': 'node-b',
      'node.name': 'node-a',
      'event.outcome': 'success',
    })
    expect(props['event.duration_ms']).toBeTypeOf('number')
  })

  it('setError marks outcome as failure and captures error fields', () => {
    const logger = createSpyLogger()
    const event = new WideEvent('http.request', logger as any)
    event.setError(new Error('connection refused'))
    event.emit()

    const [, props] = logger.info.mock.calls[0]
    expect(props['event.outcome']).toBe('failure')
    expect(props['error.type']).toBe('Error')
    expect(props['error.message']).toBe('connection refused')
  })

  it('setError handles non-Error values', () => {
    const logger = createSpyLogger()
    const event = new WideEvent('rpc.call', logger as any)
    event.setError('string error')
    event.emit()

    const [, props] = logger.info.mock.calls[0]
    expect(props['error.type']).toBe('string')
    expect(props['error.message']).toBe('string error')
  })

  it('set() with object merges multiple fields', () => {
    const logger = createSpyLogger()
    const event = new WideEvent('test.event', logger as any)
    event.set({ a: 1, b: 2 })
    event.set({ c: 3 })
    event.emit()

    const [, props] = logger.info.mock.calls[0]
    expect(props.a).toBe(1)
    expect(props.b).toBe(2)
    expect(props.c).toBe(3)
  })

  it('set() with key-value pair sets a single field', () => {
    const logger = createSpyLogger()
    const event = new WideEvent('test.event', logger as any)
    event.set('key', 'value')
    event.emit()

    const [, props] = logger.info.mock.calls[0]
    expect(props.key).toBe('value')
  })

  it('set() returns this for chaining', () => {
    const logger = createSpyLogger()
    const event = new WideEvent('test.event', logger as any)
    expect(event.set('a', 1)).toBe(event)
    expect(event.set({ b: 2 })).toBe(event)
  })

  it('does not emit twice', () => {
    const logger = createSpyLogger()
    const event = new WideEvent('test.event', logger as any)
    event.emit()
    event.emit()
    expect(logger.info).toHaveBeenCalledTimes(1)
  })

  it('explicit outcome is not overridden by default', () => {
    const logger = createSpyLogger()
    const event = new WideEvent('test.event', logger as any)
    event.set('event.outcome', 'partial')
    event.emit()

    const [, props] = logger.info.mock.calls[0]
    expect(props['event.outcome']).toBe('partial')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `cd packages/telemetry && npx vitest run tests/wide-event.unit.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
// packages/telemetry/src/wide-event.ts
import type { Logger } from '@logtape/logtape'

/**
 * Accumulates structured fields throughout a unit of work and emits
 * a single canonical "wide event" log record at completion.
 *
 * Fields become LogTape record.properties → OTEL log record attributes → Loki labels.
 */
export class WideEvent {
  private fields: Record<string, unknown> = {}
  private readonly logger: Logger
  private readonly startTime: number
  private emitted = false

  constructor(eventName: string, logger: Logger) {
    this.logger = logger
    this.startTime = Date.now()
    this.fields['event.name'] = eventName
  }

  /** Add a single field or merge multiple fields. */
  set(key: string, value: unknown): this
  set(fields: Record<string, unknown>): this
  set(keyOrFields: string | Record<string, unknown>, value?: unknown): this {
    if (typeof keyOrFields === 'string') {
      this.fields[keyOrFields] = value
    } else {
      Object.assign(this.fields, keyOrFields)
    }
    return this
  }

  /** Mark the event as errored. Does not emit. */
  setError(error: unknown): this {
    if (error instanceof Error) {
      this.set({
        'error.type': error.constructor.name,
        'error.message': error.message,
        'event.outcome': 'failure',
      })
    } else {
      this.set({
        'error.type': typeof error,
        'error.message': String(error),
        'event.outcome': 'failure',
      })
    }
    return this
  }

  /** Emit the canonical wide event log record. Only emits once. */
  emit(): void {
    if (this.emitted) return
    this.emitted = true

    this.fields['event.duration_ms'] = Date.now() - this.startTime
    if (!this.fields['event.outcome']) {
      this.fields['event.outcome'] = 'success'
    }

    const eventName = this.fields['event.name'] as string
    this.logger.info(`${eventName} completed`, this.fields)
  }
}
```

**Step 4: Export from index.ts**

Add to `packages/telemetry/src/index.ts` after the existing exports:

```typescript
// Wide event builder
export { WideEvent } from './wide-event.js'
```

**Step 5: Run test to verify it passes**

Run: `cd packages/telemetry && npx vitest run tests/wide-event.unit.test.ts`
Expected: PASS

**Step 6: Typecheck**

Run: `cd packages/telemetry && npx tsc --noEmit`
Expected: No errors

**Step 7: Commit**

```bash
gt commit -m "feat(telemetry): add WideEvent builder class for canonical structured logging"
```

---

## Task 2: Wide event Hono middleware

**Files:**

- Create: `packages/telemetry/src/middleware/wide-event.ts`
- Modify: `packages/telemetry/src/index.ts`
- Create: `packages/telemetry/tests/wide-event-middleware.unit.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/telemetry/tests/wide-event-middleware.unit.test.ts
import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import { wideEventMiddleware } from '../src/middleware/wide-event.js'

// Spy on WideEvent to capture what was emitted
vi.mock('../src/wide-event.js', () => {
  const emittedEvents: Array<{ fields: Record<string, unknown> }> = []

  class MockWideEvent {
    fields: Record<string, unknown> = {}
    constructor(eventName: string) {
      this.fields['event.name'] = eventName
    }
    set(keyOrFields: string | Record<string, unknown>, value?: unknown) {
      if (typeof keyOrFields === 'string') {
        this.fields[keyOrFields] = value
      } else {
        Object.assign(this.fields, keyOrFields)
      }
      return this
    }
    setError(error: unknown) {
      this.fields['error.message'] = error instanceof Error ? error.message : String(error)
      this.fields['event.outcome'] = 'failure'
      return this
    }
    emit() {
      emittedEvents.push({ fields: { ...this.fields } })
    }
  }

  return { WideEvent: MockWideEvent, _emittedEvents: emittedEvents }
})

// Access the emitted events spy
import { _emittedEvents } from '../src/wide-event.js'

describe('wideEventMiddleware', () => {
  it('emits a wide event with HTTP context on successful response', async () => {
    const app = new Hono()
    app.use('*', wideEventMiddleware())
    app.get('/test', (c) => c.json({ ok: true }))

    const events = _emittedEvents as any[]
    events.length = 0

    const res = await app.request('/test')
    expect(res.status).toBe(200)
    expect(events).toHaveLength(1)
    expect(events[0].fields).toMatchObject({
      'event.name': 'http.request',
      'http.method': 'GET',
      'http.status_code': 200,
    })
  })

  it('captures error status codes', async () => {
    const app = new Hono()
    app.use('*', wideEventMiddleware())
    app.get('/fail', (c) => c.json({ error: 'not found' }, 404))

    const events = _emittedEvents as any[]
    events.length = 0

    const res = await app.request('/fail')
    expect(res.status).toBe(404)
    expect(events[0].fields['event.outcome']).toBe('failure')
  })

  it('makes wideEvent available on context for handler enrichment', async () => {
    const app = new Hono()
    app.use('*', wideEventMiddleware())
    app.get('/enrich', (c) => {
      const event = c.get('wideEvent' as any)
      expect(event).toBeDefined()
      event.set('custom.field', 'custom-value')
      return c.json({ ok: true })
    })

    const events = _emittedEvents as any[]
    events.length = 0

    await app.request('/enrich')
    expect(events[0].fields['custom.field']).toBe('custom-value')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `cd packages/telemetry && npx vitest run tests/wide-event-middleware.unit.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
// packages/telemetry/src/middleware/wide-event.ts
import type { Context, MiddlewareHandler } from 'hono'
import { getLogger } from '../logger.js'
import { WideEvent } from '../wide-event.js'

export interface WideEventMiddlewareOptions {
  /** Logger category. Defaults to ['catalyst', 'wide']. */
  category?: string[]
}

export function wideEventMiddleware(options?: WideEventMiddlewareOptions): MiddlewareHandler {
  const category = options?.category ?? ['catalyst', 'wide']

  return async (c: Context, next: () => Promise<void>) => {
    const logger = getLogger(category)
    const event = new WideEvent('http.request', logger)

    event.set({
      'http.method': c.req.method,
      'http.url': c.req.path,
    })

    c.set('wideEvent' as never, event)

    try {
      await next()
      event.set('http.status_code', c.res.status)
      if (c.res.status >= 400) {
        event.set('event.outcome', 'failure')
      }
    } catch (err) {
      event.setError(err)
      throw err
    } finally {
      event.emit()
    }
  }
}
```

**Step 4: Export from index.ts**

The wide-event middleware should be exported from the hono middleware subpath. Add to `packages/telemetry/src/index.ts`:

```typescript
// Wide event middleware (available via main export — no hono dep at import time
// because it's only constructed at runtime)
export { wideEventMiddleware } from './middleware/wide-event.js'
export type { WideEventMiddlewareOptions } from './middleware/wide-event.js'
```

NOTE: Check if the hono middleware is already exported via a subpath entry. If so, export `wideEventMiddleware` alongside `telemetryMiddleware` from the same subpath instead.

**Step 5: Run test to verify it passes**

Run: `cd packages/telemetry && npx vitest run tests/wide-event-middleware.unit.test.ts`
Expected: PASS

**Step 6: Typecheck**

Run: `cd packages/telemetry && npx tsc --noEmit`
Expected: No errors

**Step 7: Commit**

```bash
gt commit -m "feat(telemetry): add wide event Hono middleware"
```

---

## Task 3: Migrate orchestrator logging

This is the largest task — 45 log calls across `orchestrator.ts` (39) and `service.ts` (6).

**Files:**

- Modify: `apps/orchestrator/src/orchestrator.ts`
- Modify: `apps/orchestrator/src/service.ts`

**Strategy:**

- Wrap `dispatch()` with a WideEvent for each action dispatch (the canonical wide event)
- Convert all template literal logs in `handleAction()`, `handleBGPNotify()`, and helper methods to structured string+properties calls
- Logs inside the wide event scope get correlation fields (`action.type`, `peer.name`, `node.name`)
- Critical errors that are state transitions remain as separate structured logs
- Remove redundant logs that the wide event already captures

**Step 1: Add WideEvent to dispatch()**

In `apps/orchestrator/src/orchestrator.ts`, modify `dispatch()` (line 231-261) to wrap with a wide event:

```typescript
async dispatch(
  sentAction: Action
): Promise<{ success: true } | { success: false; error: string }> {
  const event = new WideEvent('orchestrator.action', this.logger)
  event.set({
    'action.type': sentAction.action,
    'node.name': this.config.node.name,
  })

  const prevState = this.state

  const result = await this.handleAction(sentAction, this.state)
  if (result.success) {
    this.state = result.state
    event.set('action.result', 'success')

    this.lastNotificationPromise = this.handleNotify(sentAction, this.state, prevState).catch(
      (e) => {
        this.logger.error("Error in handleNotify for {action}: {errorMessage}", {
          "event.name": "orchestrator.notify.failed",
          action: sentAction.action,
          "error.message": String(e),
        })
      }
    )
    event.emit()
    return { success: true }
  } else {
    event.set('action.result', 'failure')
    event.set('action.error', result.error)
    event.setError(new Error(result.error))
    event.emit()
  }
  return result
}
```

**Step 2: Convert all template literal logs in orchestrator.ts**

Convert each log call from template literal to structured form. Examples of the pattern:

```typescript
// Line 240: Route create debug
// Before: this.logger.debug`Route create data: ${JSON.stringify(sentAction.data)}`
this.logger.debug('Route create data: {routeData}', {
  'event.name': 'orchestrator.action.debug',
  routeData: JSON.stringify(sentAction.data),
})

// Line 432-433: InternalProtocolUpdate received
// Before: this.logger.info`InternalProtocolUpdate: received ${update.updates.length} updates from ${peerInfo.name}`
this.logger.info('Received {updateCount} updates from {peerName}', {
  'event.name': 'route.updates.received',
  updateCount: update.updates.length,
  'peer.name': peerInfo.name,
})

// Line 443-444: Loop detected
// Before: this.logger.debug`Drop update from ${peerInfo.name}: loop detected...`
this.logger.debug('Drop update from {peerName}: loop detected in path [{nodePath}]', {
  'event.name': 'route.update.loop_detected',
  'peer.name': peerInfo.name,
  nodePath: nodePath.join(', '),
})

// Line 474: Unknown action
// Before: this.logger.warn`Unknown action: ${(action as Action).action}`
this.logger.warn('Unknown action: {action}', {
  'event.name': 'orchestrator.action.unknown',
  action: (action as Action).action,
})

// Line 525-526: LocalPeerCreate attempting connection
// Before: this.logger.info`LocalPeerCreate: attempting connection to ${action.data.name}...`
this.logger.info('Attempting connection to {peerName} at {peerEndpoint}', {
  'event.name': 'peer.session.connecting',
  'peer.name': action.data.name,
  'peer.endpoint': action.data.endpoint,
})

// Line 536: Successfully opened connection
// Before: this.logger.info`Successfully opened connection to ${action.data.name}`
this.logger.info('Peer session opened to {peerName}', {
  'event.name': 'peer.session.opened',
  'peer.name': action.data.name,
})

// Line 593-594: CRITICAL no peerToken
// Before: this.logger.error`CRITICAL: no peerToken for ${action.data.peerInfo.name}...`
this.logger.error('No peerToken for {peerName} — cannot sync routes', {
  'event.name': 'peer.auth.missing_token',
  'peer.name': action.data.peerInfo.name,
  severity: 'critical',
})

// Line 690-691: LocalRouteCreate broadcasting
// Before: this.logger.info`LocalRouteCreate: ${action.data.name}, broadcasting to ${connectedPeers.length} peers`
this.logger.info('Broadcasting route {routeName} to {peerCount} peers', {
  'event.name': 'route.advertised',
  'route.name': action.data.name,
  'peer.count': connectedPeers.length,
})

// Line 912: Propagating withdrawal
// Before: this.logger.info`Propagating withdrawal of ${removedRoutes.length} routes from ${peerName}`
this.logger.info('Propagating withdrawal of {routeCount} routes from {peerName}', {
  'event.name': 'route.withdrawn',
  'route.count': removedRoutes.length,
  'peer.name': peerName,
})
```

Apply this pattern to ALL 39 log calls in orchestrator.ts. Every template literal becomes `logger.level("message {key}", { "event.name": "...", key: value })`.

**Step 3: Convert service.ts logs**

All 6 calls in `apps/orchestrator/src/service.ts`:

```typescript
// Line 73
this.telemetry.logger.info('Token refresh check enabled (every hour)', {
  'event.name': 'token.refresh.scheduled',
})

// Line 126
this.telemetry.logger.info('Orchestrator running as {nodeName}', {
  'event.name': 'orchestrator.started',
  'node.name': this.config.node.name,
})

// Line 138
this.telemetry.logger.info('No auth service configured — skipping node token mint', {
  'event.name': 'token.mint.skipped',
})

// Line 143
this.telemetry.logger.info('Connecting to auth service at {endpoint}', {
  'event.name': 'auth.connecting',
  'auth.endpoint': endpoint,
})

// Line 172-173
this.telemetry.logger.info('Node token minted for {nodeName} (expires {expiresAt})', {
  'event.name': 'token.minted',
  'node.name': this.config.node.name,
  'token.expires_at': this._tokenExpiresAt.toISOString(),
})

// Line 175
this.telemetry.logger.error('Failed to mint node token: {errorMessage}', {
  'event.name': 'token.mint.failed',
  'error.message': String(error),
  'error.type': error instanceof Error ? error.constructor.name : typeof error,
})

// Line 192
this.telemetry.logger.info('Node token approaching expiration, refreshing', {
  'event.name': 'token.refresh.started',
})

// Line 195
this.telemetry.logger.info('Node token refreshed successfully', {
  'event.name': 'token.refreshed',
})

// Line 197
this.telemetry.logger.error('Failed to refresh node token: {errorMessage}', {
  'event.name': 'token.refresh.failed',
  'error.message': String(error),
})
```

**Step 4: Add WideEvent import**

Add to the imports at the top of `orchestrator.ts`:

```typescript
import { getLogger, WideEvent } from '@catalyst/telemetry'
```

**Step 5: Run existing tests**

Run: `cd apps/orchestrator && npx vitest run`
Expected: All existing tests pass

**Step 6: Typecheck**

Run: `cd apps/orchestrator && npx tsc --noEmit`
Expected: No errors

**Step 7: Commit**

```bash
gt commit -m "feat(orchestrator): migrate all logging to structured wide events"
```

---

## Task 4: Migrate gateway logging

**Files:**

- Modify: `apps/gateway/src/graphql/server.ts` (4 log calls)
- Modify: `apps/gateway/src/rpc/server.ts` (3 log calls)

**Step 1: Convert graphql/server.ts logs**

Add WideEvent for reload operations:

```typescript
// Add import
import { WideEvent } from '@catalyst/telemetry'

// In reload() method, wrap with wide event:
async reload(config: GatewayConfig): Promise<...> {
  const event = new WideEvent('gateway.reload', this.logger)
  event.set('gateway.service_count', config.services.length)

  // ... existing try block ...
  // On success:
  event.set({ 'gateway.duration_ms': durationMs, 'gateway.subgraph_count': subschemas.length })
  event.emit()

  // On error:
  event.setError(error)
  event.emit()
}
```

Convert remaining logs:

```typescript
// Line 60
this.logger.info('Reloading gateway with {serviceCount} services', {
  'event.name': 'gateway.reload.started',
  'gateway.service_count': config.services.length,
})

// Line 79
this.logger.warn('No services configured, using default schema', {
  'event.name': 'gateway.reload.empty',
})

// Line 111
this.logger.info('Gateway reloaded successfully in {durationMs}ms', {
  'event.name': 'gateway.reloaded',
  'gateway.duration_ms': durationMs,
})

// Line 119
this.logger.error('Gateway reload failed: {errorMessage}', {
  'event.name': 'gateway.reload.failed',
  'error.message': message,
})
```

**Step 2: Convert rpc/server.ts logs**

```typescript
// Line 46
this.logger.info('Config update received via RPC', {
  'event.name': 'gateway.config.received',
})

// Line 49
this.logger.error('Invalid config received', {
  'event.name': 'gateway.config.invalid',
})

// Line 60
this.logger.error('Config update failed: {errorMessage}', {
  'event.name': 'gateway.config.failed',
  'error.message': message,
})
```

**Step 3: Run existing tests**

Run: `cd apps/gateway && npx vitest run`
Expected: All tests pass

**Step 4: Typecheck**

Run: `cd apps/gateway && npx tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```bash
gt commit -m "feat(gateway): migrate logging to structured wide events"
```

---

## Task 5: Migrate auth / authorization logging

**Files:**

- Modify: `packages/authorization/src/service/rpc/server.ts` (~8 log calls)
- Modify: `packages/authorization/src/service/service.ts` (~3 log calls)
- Modify: `packages/authorization/src/policy/src/authorization-engine.ts` (~3 log calls)
- Modify: `apps/auth/src/server.ts` (1 console.error → structured log)

**Step 1: Convert authorization service logs**

In `packages/authorization/src/service/rpc/server.ts`:

```typescript
// Line 100
void logger.error('Policy service error: {errors}', {
  'event.name': 'auth.policy.error',
  errors: autorizedResult.errors,
})

// Line 105
void logger.warn('Permission denied: decision={decision}, reasons={reasons}', {
  'event.name': 'auth.permission.denied',
  'auth.decision': autorizedResult.decision,
  'auth.reasons': autorizedResult.reasons,
})

// Line 223
void logger.warn('Token verification failed: {error}', {
  'event.name': 'auth.token.verification_failed',
  'error.message': auth.error,
})

// Line 228
void logger.error('Policy service not configured', {
  'event.name': 'auth.policy.not_configured',
})

// Line 259
void logger.info('Authorization check - action: {action}, allowed: {allowed}', {
  'event.name': 'auth.authorization.checked',
  'auth.action': request.action,
  'auth.allowed': result.type === 'evaluated' && result.allowed,
})

// Line 263
void logger.error('Authorization system error: {errors}', {
  'event.name': 'auth.authorization.error',
  errors: result.errors.join(', '),
})

// Line 272
void logger.warn('Permission denied for action: {action}, reasons: {reasons}', {
  'event.name': 'auth.authorization.denied',
  'auth.action': request.action,
  'auth.reasons': result.reasons.join(', '),
})
```

In `packages/authorization/src/service/service.ts`:

```typescript
// Line 50
void logger.info('JWTTokenFactory initialized', {
  'event.name': 'auth.token_factory.initialized',
})

// Line 59
void logger.error('Invalid policies - policy validation failed', {
  'event.name': 'auth.policy.validation_failed',
})

// Line 77
void logger.info('System Admin Token minted: {token}', {
  'event.name': 'auth.system_token.minted',
  token: this._systemToken,
})
```

In `packages/authorization/src/policy/src/authorization-engine.ts`:

```typescript
// Line 69
logger.error('Validation errors: {errors}', {
  'event.name': 'auth.policy.validation_errors',
  errors: JSON.stringify(validationAnswer.validationErrors, null, 2),
})

// Line 72
logger.warn('Validation warnings: {warnings}', {
  'event.name': 'auth.policy.validation_warnings',
  warnings: JSON.stringify(validationAnswer.validationWarnings, null, 2),
})

// Line 75
logger.warn('Other warnings: {warnings}', {
  'event.name': 'auth.policy.other_warnings',
  warnings: JSON.stringify(validationAnswer.otherWarnings, null, 2),
})
```

**Step 2: Run existing tests**

Run: `cd packages/authorization && npx vitest run`
Expected: All tests pass

**Step 3: Typecheck**

Run: `cd packages/authorization && npx tsc --noEmit`

**Step 4: Commit**

```bash
gt commit -m "feat(auth): migrate logging to structured wide events"
```

---

## Task 6: Migrate envoy logging

**Files:**

- Modify: `apps/envoy/src/xds/control-plane.ts` (14 log calls)
- Modify: `apps/envoy/src/rpc/server.ts` (6 log calls)
- Modify: `apps/envoy/src/service.ts` (1 log call)

**Step 1: Add wide events to envoy RPC updateRoutes()**

In `apps/envoy/src/rpc/server.ts`, wrap `updateRoutes()` with a wide event:

```typescript
import { WideEvent } from '@catalyst/telemetry'

async updateRoutes(config: unknown): Promise<UpdateResult> {
  const event = new WideEvent('envoy.route_update', this.logger)

  // ... validation and processing ...
  // On success:
  event.set({
    'envoy.route_count': total,
    'envoy.local_count': this.config.local.length,
    'envoy.internal_count': this.config.internal.length,
  })
  // If snapshot pushed:
  event.set({
    'xds.snapshot_version': snapshot.version,
    'xds.listener_count': snapshot.listeners.length,
    'xds.cluster_count': snapshot.clusters.length,
  })
  event.emit()
}
```

**Step 2: Convert control-plane.ts logs**

Convert all 14 template literal logs to structured form:

```typescript
// Line 86-87
this.logger.warn('xDS ADS server using insecure credentials on {address}:{port}', {
  'event.name': 'xds.server.insecure',
  'xds.bind_address': this.bindAddress,
  'xds.port': boundPort,
})

// Line 89
this.logger.info('xDS ADS server listening on {address}:{port}', {
  'event.name': 'xds.server.started',
  'xds.bind_address': this.bindAddress,
  'xds.port': boundPort,
})

// Line 110
this.logger.warn('xDS ADS server graceful shutdown timed out, forcing', {
  'event.name': 'xds.server.shutdown_timeout',
})

// Line 121
this.logger.info('xDS ADS server stopped', {
  'event.name': 'xds.server.stopped',
})

// Line 139
this.logger.info('New ADS stream connected', {
  'event.name': 'xds.client.connected',
})

// Line 181
this.logger.info('Subscribe request for {typeUrl}', {
  'event.name': 'xds.client.subscribed',
  'xds.resource_type': typeUrl,
})

// Line 185-186
this.logger.warn('NACK received for {typeUrl} nonce={nonce} error={errorMessage}', {
  'event.name': 'xds.client.nacked',
  'xds.resource_type': typeUrl,
  'xds.nonce': request.response_nonce,
  'error.message': request.error_detail.message,
})

// Line 189
this.logger.info('ACK received for {typeUrl} v{version}', {
  'event.name': 'xds.client.acked',
  'xds.resource_type': typeUrl,
  'xds.version': request.version_info,
})

// Line 192
this.logger.error('Failed to decode DiscoveryRequest: {error}', {
  'event.name': 'xds.request.decode_failed',
  'error.message': String(err),
})

// Line 198
this.logger.info('ADS stream disconnected', {
  'event.name': 'xds.client.disconnected',
})

// Line 207
this.logger.error('ADS stream error: {error}', {
  'event.name': 'xds.stream.error',
  'error.message': String(err),
})

// Line 238
this.logger.info('Sent CDS v{version} ({clusterCount} clusters)', {
  'event.name': 'xds.snapshot.cds_sent',
  'xds.version': snapshot.version,
  'xds.cluster_count': snapshot.clusters.length,
})

// Line 257
this.logger.info('Sent LDS v{version} ({listenerCount} listeners)', {
  'event.name': 'xds.snapshot.lds_sent',
  'xds.version': snapshot.version,
  'xds.listener_count': snapshot.listeners.length,
})
```

**Step 3: Convert service.ts and rpc/server.ts remaining logs**

Apply same pattern to all remaining template literal calls.

**Step 4: Run existing tests**

Run: `cd apps/envoy && npx vitest run`
Expected: All tests pass

**Step 5: Typecheck**

Run: `cd apps/envoy && npx tsc --noEmit`

**Step 6: Commit**

```bash
gt commit -m "feat(envoy): migrate logging to structured wide events"
```

---

## Task 7: Migrate node logging

**Files:**

- Modify: `apps/node/src/server/rpc.ts` (1 log call)
- Modify: `apps/node/src/server/index.ts` (1 log call)
- Modify: `apps/node/src/service.ts` (1 log call)
- Modify: `apps/node/src/cli/client.ts` (1 log call)

**Step 1: Convert all 4 log calls**

```typescript
// apps/node/src/server/rpc.ts line 35
logger.info('Shutdown requested via RPC', {
  'event.name': 'node.shutdown.requested',
})

// apps/node/src/server/index.ts line 6
logger.info('RPC server initialized', {
  'event.name': 'node.rpc.initialized',
})

// apps/node/src/service.ts line 25
this.telemetry.logger.info('RPC server initialized', {
  'event.name': 'node.rpc.initialized',
})

// apps/node/src/cli/client.ts line 10
this.logger.info('Connecting to Catalyst Node RPC', {
  'event.name': 'node.rpc.connecting',
})
```

**Step 2: Run existing tests**

Run: `cd apps/node && npx vitest run`
Expected: All tests pass

**Step 3: Commit**

```bash
gt commit -m "feat(node): migrate logging to structured events"
```

---

## Task 8: Verify full build and all tests

**Step 1: Full typecheck across monorepo**

Run: `npx tsc --build` (or the monorepo's typecheck script)

**Step 2: Run all tests**

Run: `pnpm test`
Expected: All tests pass across all packages

**Step 3: Grep for remaining template literals**

Run: Search for any remaining template-literal log calls:

```bash
rg 'logger\.(info|warn|error|debug|fatal)`' apps/ packages/ --glob '*.ts'
```

Expected: Zero results — all template literals converted

**Step 4: Final commit if any fixups needed**

```bash
gt commit -m "fix: resolve remaining template literal log calls"
```

**Step 5: Submit PR**

```bash
gt submit
```
