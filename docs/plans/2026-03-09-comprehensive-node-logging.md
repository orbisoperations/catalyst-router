# Comprehensive Node Logging Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add ~45 structured log events across 6 categories so operators can diagnose any Catalyst node issue from logs alone, without SSH access.

**Architecture:** All new logging uses the existing `logger.info("message {key}", { "event.name": "...", key: value })` pattern from LogTape. WideEvent is used for operations with duration tracking. No new infrastructure — just adding log calls at the right places and converting remaining template literals.

**Tech Stack:** LogTape, `@catalyst/telemetry` (WideEvent, getLogger), OpenTelemetry OTLP export, Loki for storage, Grafana for visualization.

**Normal deployment:** Single node with orchestrator + gateway + auth + envoy. Two-node compose is test-only for peering.

---

## Task 1: Convert V2 Orchestrator Template Literals

Convert all 16 template literal logger calls in the V2 orchestrator to structured `string + properties` format.

**Files:**

- Modify: `apps/orchestrator/src/v2/catalyst-service.ts`
- Modify: `apps/orchestrator/src/v2/reconnect.ts`
- Modify: `apps/orchestrator/src/v2/ws-transport.ts`
- Modify: `apps/orchestrator/src/v2/rpc.ts`
- Test: `apps/orchestrator/tests/v2-structured-logging.unit.test.ts`

**Context:** The V2 orchestrator uses LogTape's tagged template syntax (`logger.info\`...\``) which produces readable messages but makes interpolated values **not queryable** as structured fields. We need to switch to the string + properties form.

**Pattern to follow (from V1):**

```typescript
// BEFORE (template literal — values NOT queryable):
logger.info`Opened connection to ${peer.name}`

// AFTER (string + properties — values ARE queryable):
logger.info('Opened connection to {peerName}', {
  'event.name': 'peer.session.opened',
  'peer.name': peer.name,
})
```

**Step 1: Write the failing test**

Create `apps/orchestrator/tests/v2-structured-logging.unit.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

// We'll test that key V2 code paths produce structured log calls.
// The approach: mock getLogger, exercise the code, assert log was called
// with string + properties (not template literal).

describe('V2 orchestrator structured logging', () => {
  it('should use string+properties format, not template literals', () => {
    // This test verifies the migration is complete by checking
    // that no template literal logger calls remain in V2 files.
    // We do this as a static analysis check.
    const fs = await import('node:fs')
    const path = await import('node:path')

    const v2Dir = path.resolve(__dirname, '../src/v2')
    const files = fs.readdirSync(v2Dir).filter((f) => f.endsWith('.ts'))

    for (const file of files) {
      const content = fs.readFileSync(path.join(v2Dir, file), 'utf-8')
      // Match logger.info`...`, logger.warn`...`, logger.error`...`
      const templateLiteralLogs = content.match(/logger\.(info|warn|error|debug)`/g)
      expect(
        templateLiteralLogs,
        `${file} still contains template literal logger calls: ${templateLiteralLogs?.join(', ')}`
      ).toBeNull()

      // Also check this.telemetry.logger pattern
      const telemetryTemplateLogs = content.match(
        /this\.telemetry\.logger\.(info|warn|error|debug)`/g
      )
      expect(
        telemetryTemplateLogs,
        `${file} still contains template literal telemetry logger calls`
      ).toBeNull()
    }
  })
})
```

**Step 2: Run test to verify it fails**

Run: `cd apps/orchestrator && pnpm vitest run tests/v2-structured-logging.unit.test.ts`
Expected: FAIL — 4 files still have template literal calls.

**Step 3: Convert all 16 calls**

**`catalyst-service.ts` (10 calls):**

| Line    | Before                                                                                 | After                                                                                                                                                                                                                     |
| ------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 102     | `this.telemetry.logger.info\`Token refresh check enabled (every hour)\``               | `this.telemetry.logger.info("Token refresh check enabled (interval={interval})", { "event.name": "node.token.refresh_scheduled", interval: "1h" })`                                                                       |
| 158     | `this.telemetry.logger.info\`Orchestrator v2 running as ${this.config.node.name}\``    | `this.telemetry.logger.info("Orchestrator v2 running as {nodeName}", { "event.name": "orchestrator.started", "node.name": this.config.node.name })`                                                                       |
| 191     | `logger.warn\`Token validation failed for action ${action}: ${permissionsApi.error}\`` | `logger.warn("Token validation failed for action {action}: {error}", { "event.name": "auth.token.validation_failed", action, "error.message": permissionsApi.error })`                                                    |
| 204     | `logger.warn\`Authorization denied for action ${action}: ${result.errorType}\``        | `logger.warn("Authorization denied for action {action}: {errorType}", { "event.name": "auth.authorization.denied", action, "error.type": result.errorType })`                                                             |
| 214     | `logger.error\`Token validation error for action ${action}: ${error}\``                | `logger.error("Token validation error for action {action}: {error}", { "event.name": "auth.token.validation_error", action, error })`                                                                                     |
| 223     | `this.telemetry.logger.info\`No auth service configured -- skipping node token mint\`` | `this.telemetry.logger.info("No auth service configured — skipping node token mint", { "event.name": "node.token.mint_skipped" })`                                                                                        |
| 228     | `this.telemetry.logger.info\`Connecting to auth service at ${endpoint}\``              | `this.telemetry.logger.info("Connecting to auth service at {endpoint}", { "event.name": "node.token.mint_connecting", "auth.endpoint": endpoint })`                                                                       |
| 255-256 | `this.telemetry.logger.info\`Node token minted...\``                                   | `this.telemetry.logger.info("Node token minted for {nodeName} (expires {expiresAt})", { "event.name": "node.token.minted", "node.name": this.config.node.name, "token.expires_at": this._tokenExpiresAt.toISOString() })` |
| 263     | `this.telemetry.logger.error\`Failed to mint node token: ${error}\``                   | `this.telemetry.logger.error("Failed to mint node token: {error}", { "event.name": "node.token.mint_failed", error })`                                                                                                    |
| 280     | `this.telemetry.logger.info\`Node token approaching expiration, refreshing...\``       | `this.telemetry.logger.info("Node token approaching expiration, refreshing", { "event.name": "node.token.refresh_started" })`                                                                                             |
| 283     | `this.telemetry.logger.info\`Node token refreshed successfully\``                      | `this.telemetry.logger.info("Node token refreshed successfully", { "event.name": "node.token.refreshed" })`                                                                                                               |
| 285     | `this.telemetry.logger.error\`Failed to refresh node token: ${error}\``                | `this.telemetry.logger.error("Failed to refresh node token: {error}", { "event.name": "node.token.refresh_failed", error })`                                                                                              |

**`reconnect.ts` (1 call):**

| Line | Before                                                                       | After                                                                                                                                                              |
| ---- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 54   | `logger.warn\`Skipping reconnect to ${peer.name}: no node token available\`` | `logger.warn("Skipping reconnect to {peerName}: no node token available", { "event.name": "peer.reconnect.skipped", "peer.name": peer.name, reason: "no_token" })` |

**`ws-transport.ts` (2 calls):**

| Line | Before                                                                        | After                                                                                                                                                  |
| ---- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 83   | `logger.info\`Opened connection to ${peer.name}\``                            | `logger.info("Opened connection to {peerName}", { "event.name": "peer.session.opened", "peer.name": peer.name, "peer.endpoint": peer.endpoint })`      |
| 120  | `logger.warn\`No peerToken for ${peer.name} — closing without notification\`` | `logger.warn("No peerToken for {peerName} — closing without notification", { "event.name": "peer.session.close_unnotified", "peer.name": peer.name })` |

**`rpc.ts` (2 calls):**

| Line | Before                                                                                                   | After                                                                                                                                                                                                     |
| ---- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 202  | `logger.warn\`iBGP identity mismatch: JWT sub=${peerIdentity} but peerInfo.name=${peerInfo.name}\``      | `logger.warn("iBGP identity mismatch: JWT sub={jwtSub} but peerInfo.name={peerName}", { "event.name": "peer.auth.identity_mismatch", "jwt.sub": peerIdentity, "peer.name": peerInfo.name })`              |
| 237  | `logger.warn\`iBGP nodePath[0] mismatch: JWT sub=${peerIdentity} but nodePath[0]=${entry.nodePath[0]}\`` | `logger.warn("iBGP nodePath[0] mismatch: JWT sub={jwtSub} but nodePath[0]={nodePath0}", { "event.name": "peer.auth.nodepath_mismatch", "jwt.sub": peerIdentity, "route.nodepath_0": entry.nodePath[0] })` |

**Step 4: Run test to verify it passes**

Run: `cd apps/orchestrator && pnpm vitest run tests/v2-structured-logging.unit.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
gt commit create --all --no-interactive -m "refactor(orchestrator): convert V2 template literals to structured logging"
```

---

## Task 2: Node Lifecycle & Startup Logging

Add structured logs for startup sequence, config loading, and shutdown.

**Files:**

- Modify: `packages/service/src/catalyst-service.ts:83-121` (initialize)
- Modify: `packages/service/src/catalyst-service.ts:129-146` (shutdown)
- Modify: `packages/service/src/catalyst-hono-server.ts:98-186` (server start)
- Modify: `packages/service/src/catalyst-hono-server.ts:197-220` (server stop)
- Test: `packages/service/tests/lifecycle-logging.unit.test.ts`

**Step 1: Write the failing test**

Test that lifecycle events are emitted with the correct `event.name` values. Mock `getLogger` or use LogTape's test utilities.

Key assertions:

- `service.initialized` already exists (line 112) — verify it has `duration_ms`
- `service.shutting_down` already exists (line 134) — verify it has service count
- New: `server.shutdown.started` when `stop()` is called
- New: `server.shutdown.completed` with `duration_ms` and services stopped count

**Step 2: Implement lifecycle logging**

In `catalyst-service.ts:83`, add a start time and emit duration:

```typescript
async initialize(): Promise<void> {
  // ...existing checks...
  const startTime = Date.now()
  // ...existing telemetry setup...
  await this.onInitialize()

  this._state = 'ready'
  this.telemetry.logger.info('{name} v{version} initialized in {durationMs}ms', {
    'event.name': 'service.initialized',
    name: this.info.name,
    version: this.info.version,
    'event.duration_ms': Date.now() - startTime,
  })
}
```

In `catalyst-service.ts:129`, add shutdown duration:

```typescript
async shutdown(): Promise<void> {
  if (this._state !== 'ready') return
  this._state = 'shutting_down'
  const startTime = Date.now()
  try {
    this.telemetry.logger.info('{name} shutting down', {
      'event.name': 'service.shutdown.started',
      name: this.info.name,
    })
    await this.onShutdown()
  } finally {
    const duration = Date.now() - startTime
    this.telemetry.logger.info('{name} shutdown completed in {durationMs}ms', {
      'event.name': 'service.shutdown.completed',
      name: this.info.name,
      'event.duration_ms': duration,
    })
    if (!this._prebuiltTelemetry) {
      await shutdownTelemetry()
    }
    this._state = 'stopped'
  }
}
```

In `catalyst-hono-server.ts:197`, add shutdown logging:

```typescript
async stop(): Promise<void> {
  const startTime = Date.now()
  const serviceCount = this._options.services?.length ?? 0
  this._logger.info('Server shutdown started (services={serviceCount})', {
    'event.name': 'server.shutdown.started',
    'service.count': serviceCount,
  })

  // ...existing shutdown logic...

  this._logger.info('Server shutdown completed in {durationMs}ms', {
    'event.name': 'server.shutdown.completed',
    'event.duration_ms': Date.now() - startTime,
    'service.count': serviceCount,
  })
}
```

**Step 3: Run tests**

Run: `cd packages/service && pnpm vitest run tests/lifecycle-logging.unit.test.ts`

**Step 4: Commit**

```bash
gt commit create --all --no-interactive -m "feat(service): add structured lifecycle logging for startup and shutdown"
```

---

## Task 3: Peering & Reconnection Logging

Add structured logs for reconnection attempts, peer state changes, and keepalive tracking.

**Files:**

- Modify: `apps/orchestrator/src/v2/reconnect.ts`
- Modify: `apps/orchestrator/src/v2/ws-transport.ts`
- Modify: `apps/orchestrator/src/v2/bus.ts`
- Test: `apps/orchestrator/tests/v2-peering-logging.unit.test.ts`

**Step 1: Write the failing test**

Test reconnect lifecycle logging:

- `peer.reconnect.scheduled` with `attempt_number`, `backoff_ms`, `peer.name`
- `peer.reconnect.succeeded` with `attempt_number`, `peer.name`
- `peer.reconnect.failed` with `attempt_number`, `peer.name`
- `peer.keepalive.sent` in bus.ts handleKeepalives

**Step 2: Implement peering logs**

**`reconnect.ts` — add logging around the reconnect cycle:**

```typescript
// Line 49, after calculating delay:
logger.info('Scheduling reconnect to {peerName} (attempt {attempt}, delay {delayMs}ms)', {
  'event.name': 'peer.reconnect.scheduled',
  'peer.name': peer.name,
  'reconnect.attempt': attempt,
  'reconnect.delay_ms': delay,
})

// Line 58, after successful openPeer:
logger.info('Reconnected to {peerName} after {attempt} attempt(s)', {
  'event.name': 'peer.reconnect.succeeded',
  'peer.name': peer.name,
  'reconnect.attempt': attempt,
})

// Line 65, in catch block before scheduling next attempt:
logger.warn('Reconnect to {peerName} failed (attempt {attempt}), will retry', {
  'event.name': 'peer.reconnect.failed',
  'peer.name': peer.name,
  'reconnect.attempt': attempt,
})
```

**`bus.ts` — add logging in handleKeepalives and handleBGPNotify:**

Add `import { getLogger } from '@catalyst/telemetry'` and `const logger = getLogger(['catalyst', 'orchestrator', 'bus'])` at top.

```typescript
// In handleKeepalives, after successful sendKeepalive (line 206):
// Keep this as debug-level — keepalives are high-frequency
logger.debug('Keepalive sent to {peerName}', {
  'event.name': 'peer.keepalive.sent',
  'peer.name': peer.name,
})

// In handleBGPNotify, when syncing initial routes (line 114):
logger.info('Peer {peerName} connected, syncing full route table', {
  'event.name': 'peer.sync.started',
  'peer.name': peerName,
})

// In handleBGPNotify, in the catch of delta propagation (line 129):
logger.warn('Failed to send route updates to {peerName}', {
  'event.name': 'peer.sync.failed',
  'peer.name': peer.name,
})
```

**Step 3: Run tests**

Run: `cd apps/orchestrator && pnpm vitest run tests/v2-peering-logging.unit.test.ts`

**Step 4: Commit**

```bash
gt commit create --all --no-interactive -m "feat(orchestrator): add structured peering and reconnection logging"
```

---

## Task 4: Route Exchange & Convergence Logging

Add structured logs for route table changes, convergence, and sync operations.

**Files:**

- Modify: `apps/orchestrator/src/v2/bus.ts`
- Test: `apps/orchestrator/tests/v2-route-logging.unit.test.ts`

**Step 1: Write the failing test**

Test that route operations produce structured logs:

- `route.table.changed` with `added`, `removed`, `trigger`
- `route.sync.completed` with `peer.name`, `route_count`
- `route.sync.empty` when no routes to sync

**Step 2: Implement route logging**

**`bus.ts` — in dispatch(), after commit:**

```typescript
// Line 76, after rib.commit succeeds:
if (plan.routeChanges.length > 0) {
  const added = plan.routeChanges.filter((c) => c.type === 'added').length
  const removed = plan.routeChanges.filter((c) => c.type === 'removed').length
  const modified = plan.routeChanges.filter(
    (c) => c.type !== 'added' && c.type !== 'removed'
  ).length
  logger.info('Route table changed: +{added} -{removed} ~{modified} (trigger={trigger})', {
    'event.name': 'route.table.changed',
    'route.added': added,
    'route.removed': removed,
    'route.modified': modified,
    'route.trigger': action.action,
    'route.total': committed.local.routes.length + committed.internal.routes.length,
  })
}
```

**`bus.ts` — in syncRoutesToPeer:**

```typescript
// Line 177, when no routes to sync:
if (updates.length === 0) {
  logger.info('No routes to sync to peer {peerName}', {
    'event.name': 'route.sync.empty',
    'peer.name': peer.name,
  })
  return
}

// After sendUpdate (line 180):
logger.info('Synced {count} route(s) to peer {peerName}', {
  'event.name': 'route.sync.completed',
  'peer.name': peer.name,
  'route.count': updates.length,
})
```

**Step 3: Run tests**

Run: `cd apps/orchestrator && pnpm vitest run tests/v2-route-logging.unit.test.ts`

**Step 4: Commit**

```bash
gt commit create --all --no-interactive -m "feat(orchestrator): add structured route exchange and convergence logging"
```

---

## Task 5: Gateway Federation Logging

Add structured logs for subgraph SDL validation and schema stitching details.

**Files:**

- Modify: `apps/gateway/src/graphql/server.ts`
- Test: `apps/gateway/tests/gateway-logging.unit.test.ts`

**Step 1: Write the failing test**

Test that gateway operations produce structured logs:

- `gateway.subgraph.sdl_validated` with `subgraph.name`, `valid`
- `gateway.stitching.completed` with `subgraph_count`, `type_count`

**Step 2: Implement gateway logging**

In `server.ts`, during the reload loop where each service SDL is validated, add per-service logging:

```typescript
// After successful SDL validation for a service:
this.logger.info('SDL validated for {serviceName}', {
  'event.name': 'gateway.subgraph.sdl_validated',
  'subgraph.name': service.url,
  valid: true,
})

// When SDL validation fails:
this.logger.warn('SDL validation failed for {serviceName}: {error}', {
  'event.name': 'gateway.subgraph.sdl_validated',
  'subgraph.name': service.url,
  valid: false,
  'error.message': errorMessage,
})
```

**Step 3: Run tests**

Run: `cd apps/gateway && pnpm vitest run tests/gateway-logging.unit.test.ts`

**Step 4: Commit**

```bash
gt commit create --all --no-interactive -m "feat(gateway): add structured SDL validation and stitching logging"
```

---

## Task 6: Envoy Data Plane Logging

Add structured logs for xDS config diffs and repeated NACK detection.

**Files:**

- Modify: `apps/envoy/src/xds/control-plane.ts`
- Modify: `apps/envoy/src/rpc/server.ts`
- Test: `apps/envoy/tests/envoy-logging.unit.test.ts`

**Step 1: Write the failing test**

Test:

- `envoy.config.diff` with `clusters_added`, `clusters_removed`, `listeners_added`, `listeners_removed`
- `envoy.nack.repeated` when a client NACKs 3+ times

**Step 2: Implement envoy logging**

In `rpc/server.ts`, when building a new xDS snapshot, compute the diff from the previous snapshot:

```typescript
// Before pushing the new snapshot, compare with previous:
if (previousSnapshot) {
  const prevClusterNames = new Set(previousSnapshot.clusters.map((c) => c.name))
  const newClusterNames = new Set(snapshot.clusters.map((c) => c.name))
  const clustersAdded = [...newClusterNames].filter((n) => !prevClusterNames.has(n)).length
  const clustersRemoved = [...prevClusterNames].filter((n) => !newClusterNames.has(n)).length

  logger.info('xDS config diff: clusters +{added} -{removed}', {
    'event.name': 'envoy.config.diff',
    'xds.clusters_added': clustersAdded,
    'xds.clusters_removed': clustersRemoved,
    'xds.version': snapshot.version,
  })
}
```

In `control-plane.ts`, track NACK counts per client and log when threshold exceeded:

```typescript
// In the NACK handler, after existing logging:
const nackCount = (this.clientNackCounts.get(clientId) ?? 0) + 1
this.clientNackCounts.set(clientId, nackCount)
if (nackCount >= 3 && nackCount % 3 === 0) {
  logger.warn('Client {clientId} has NACKed {nackCount} times', {
    'event.name': 'envoy.nack.repeated',
    'xds.client_id': clientId,
    'xds.nack_count': nackCount,
    'xds.resource_type': resourceType,
  })
}
```

**Step 3: Run tests**

Run: `cd apps/envoy && pnpm vitest run tests/envoy-logging.unit.test.ts`

**Step 4: Commit**

```bash
gt commit create --all --no-interactive -m "feat(envoy): add structured xDS config diff and NACK tracking logging"
```

---

## Task 7: Security & Audit Logging

Add structured logs for key rotation, token lifecycle, and policy evaluation.

**Files:**

- Modify: `packages/authorization/src/key-manager/persistent.ts:260-284`
- Modify: `packages/authorization/src/jwt/local/index.ts`
- Modify: `packages/authorization/src/service/rpc/server.ts`
- Test: `packages/authorization/tests/security-logging.unit.test.ts`

**Step 1: Write the failing test**

Test:

- `auth.cert.rotation.started` with `old_key_id`, `new_key_id`
- `auth.cert.rotation.completed` with `grace_period_ends_at`
- `auth.token.minted` with `subject`, `principal`
- `auth.token.revoked` with `jti` or `san`

**Step 2: Implement security logging**

**`persistent.ts` — add logger and rotation events:**

Add `import { getLogger } from '@catalyst/telemetry'` and `const logger = getLogger(['catalyst', 'auth', 'keys'])`.

```typescript
// In rotate(), line 268 after generating new key:
logger.info('Key rotation started: old={oldKeyId} new={newKeyId}', {
  'event.name': 'auth.cert.rotation.started',
  'key.old_id': oldKey.kid,
  'key.new_id': newKey.kid,
  immediate,
})

// Line 277 after persist:
logger.info('Key rotation completed: old={oldKeyId} new={newKeyId}', {
  'event.name': 'auth.cert.rotation.completed',
  'key.old_id': oldKey.kid,
  'key.new_id': newKey.kid,
  'key.grace_period_ends_at': oldKey.expiresAt
    ? new Date(oldKey.expiresAt).toISOString()
    : undefined,
})
```

**`local/index.ts` — add token lifecycle events:**

Add `import { getLogger } from '@catalyst/telemetry'` and `const logger = getLogger(['catalyst', 'auth', 'token'])`.

```typescript
// In mint(), line 58 after recording:
logger.info('Token minted: jti={jti} subject={subject} principal={principal}', {
  'event.name': 'auth.token.minted',
  'token.jti': decoded.jti,
  'token.subject': options.subject,
  'token.principal': options.principal,
  'token.entity_type': options.entity.type,
  'token.expires_at': new Date(decoded.exp * 1000).toISOString(),
})

// In revoke(), line 64-68:
if (options.jti) {
  logger.info('Token revoked by JTI: {jti}', {
    'event.name': 'auth.token.revoked',
    'token.jti': options.jti,
    'revoke.method': 'jti',
  })
}
if (options.san) {
  logger.info('Tokens revoked by SAN: {san}', {
    'event.name': 'auth.token.revoked',
    'token.san': options.san,
    'revoke.method': 'san',
  })
}

// In verify(), line 82-83 when token is revoked:
logger.warn('Token rejected (revoked): jti={jti}', {
  'event.name': 'auth.token.rejected',
  'token.jti': jti,
  reason: 'revoked',
})
```

**`rpc/server.ts` — enhance policy evaluation logging:**

The existing `auth.authorization.checked` log (line 274) already captures the decision. Add the determining policy details:

```typescript
// In permissions().authorizeAction, after result:
logger.info('Authorization check: action={action} allowed={allowed}', {
  'event.name': 'auth.policy.evaluated',
  'auth.action': request.action,
  'auth.allowed': result.type === 'evaluated' && result.allowed,
  'auth.decision': result.type === 'evaluated' ? result.decision : 'error',
  'auth.reasons': result.type === 'evaluated' ? result.reasons : [],
})
```

**Step 3: Run tests**

Run: `cd packages/authorization && pnpm vitest run tests/security-logging.unit.test.ts`

**Step 4: Commit**

```bash
gt commit create --all --no-interactive -m "feat(auth): add structured key rotation, token lifecycle, and policy evaluation logging"
```

---

## Task 8: Manual Verification with Docker Compose + Playwright

Verify all new structured logs appear correctly in the running system.

**Test Environment:** Single-node `docker-compose/docker.compose.yaml` (normal production topology). Two-node `docker-compose/two-node.compose.yaml` only for peering tests.

### 8a: Single-Node Stack Verification

**Step 1: Rebuild and start**

```bash
cd docker-compose
docker compose -f docker.compose.yaml down -v
docker compose -f docker.compose.yaml up --build -d
# Wait for all services healthy
docker compose -f docker.compose.yaml ps
```

**Step 2: Verify startup logs via docker logs**

```bash
# Check orchestrator startup events
docker compose -f docker.compose.yaml logs orchestrator | grep 'event.name'
```

Expected events in orchestrator logs:

- `service.initialized` with `duration_ms`
- `orchestrator.started` with `node.name`
- `node.token.minted` or `node.token.mint_skipped`
- `server.listening` with `port`

**Step 3: Hit endpoints to generate request logs**

```bash
# Generate HTTP request wide events
curl http://localhost:3000/health
curl http://localhost:4000/health
curl http://localhost:4020/health
curl http://localhost:3010/health
```

**Step 4: Verify in Grafana/Loki via Playwright**

1. Navigate to `http://localhost:3050` (Grafana)
2. Go to Explore → select "Loki" datasource
3. Query: `{service_name="orchestrator"} |= "event.name"`
4. Verify structured fields are present and parseable
5. Query: `{service_name="orchestrator"} | json | event_name = "orchestrator.started"`
6. Verify the new startup events appear
7. Query: `{service_name="auth"} | json | event_name =~ "auth.token.*"`
8. Verify token lifecycle events appear

**Step 5: Verify Catalyst dashboard**

1. Navigate to `http://localhost:3000/dashboard`
2. Click orchestrator → verify Metrics/Traces/Logs links work
3. Click Logs → verify it opens Grafana with orchestrator logs
4. Expand a log entry → verify structured fields visible

**Step 6: Screenshot results**

Take screenshots of:

- Grafana Loki showing structured orchestrator events
- Grafana Loki showing auth token events
- Catalyst dashboard with expanded service card

### 8b: Two-Node Peering Verification

**Step 1: Start two-node stack**

```bash
cd docker-compose
docker compose -f docker.compose.yaml down
docker compose -f two-node.compose.yaml up --build -d
# Wait for all healthy
```

**Step 2: Verify peering events**

```bash
# Check node-a logs for peering events
docker compose -f two-node.compose.yaml logs node-a | grep 'peer\.'
```

Expected events:

- `peer.session.opened` with `peer.name=node-b...`
- `peer.sync.started` or `route.sync.completed`
- `peer.keepalive.sent` (debug level, may need OTEL debug config)

**Step 3: Simulate peer disconnect**

```bash
# Stop node-b to trigger reconnection on node-a
docker compose -f two-node.compose.yaml stop node-b
sleep 5
docker compose -f two-node.compose.yaml logs node-a --since 10s | grep 'peer\.'
```

Expected events:

- `peer.reconnect.scheduled` with `attempt_number=1`
- `peer.reconnect.failed` (node-b is down)
- `peer.reconnect.scheduled` with `attempt_number=2`, higher `backoff_ms`

**Step 4: Restart and verify recovery**

```bash
docker compose -f two-node.compose.yaml start node-b
sleep 15
docker compose -f two-node.compose.yaml logs node-a --since 20s | grep 'peer\.'
```

Expected events:

- `peer.reconnect.succeeded`
- `peer.sync.started`
- `route.sync.completed`

**Step 5: Verify in Grafana**

1. Navigate to `http://localhost:3050`
2. Explore → Loki → `{service_name="orchestrator-node-a"} | json | event_name =~ "peer.*"`
3. Verify the full reconnection lifecycle is visible
4. Screenshot the results

**Step 6: Clean up**

```bash
docker compose -f two-node.compose.yaml down
```

---

## Summary

| Task      | Category                    | Files        | New Events                |
| --------- | --------------------------- | ------------ | ------------------------- |
| 1         | Template literal conversion | 4 files      | 0 new (16 conversions)    |
| 2         | Node lifecycle              | 2 files      | 4 new events              |
| 3         | Peering & reconnection      | 3 files      | 6 new events              |
| 4         | Route exchange              | 1 file       | 3 new events              |
| 5         | Gateway federation          | 1 file       | 2 new events              |
| 6         | Envoy data plane            | 2 files      | 2 new events              |
| 7         | Security & audit            | 3 files      | 7 new events              |
| 8         | Manual verification         | 0 files      | 0 (testing only)          |
| **Total** |                             | **16 files** | **24 new + 16 converted** |
