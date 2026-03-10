# OTel Attribute Naming Alignment — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename all custom WideEvent and logger attribute keys to follow `catalyst.<component>.<property>` per OTel semantic convention naming.

**Architecture:** Mechanical string-literal replacement across source and test files. Standard OTel attributes (`exception.*`, `http.*`, `url.path`, `error.type`, `event.name`) stay unchanged. Custom attributes get the `catalyst.event.*` prefix (shared telemetry) or `catalyst.orchestrator.*` prefix (orchestrator-specific).

**Tech Stack:** TypeScript, Vitest (test runner)

**Spec:** `docs/superpowers/specs/2026-03-10-otel-attribute-naming-design.md`

---

## Chunk 1: Shared Telemetry + Service Packages

### Task 1: Rename WideEvent core attributes

**Files:**

- Modify: `packages/telemetry/src/wide-event.ts`
- Modify: `packages/telemetry/src/middleware/wide-event.ts`
- Modify: `packages/telemetry/tests/wide-event.unit.test.ts`
- Modify: `packages/telemetry/tests/wide-event-middleware.unit.test.ts`

**Renames in `wide-event.ts`:**

| Line(s)    | Old                                                               | New                                                   |
| ---------- | ----------------------------------------------------------------- | ----------------------------------------------------- |
| 53, 59     | `'event.outcome': 'failure'`                                      | `'catalyst.event.outcome': 'failure'`                 |
| 67 (JSDoc) | `event.duration_ms`                                               | `catalyst.event.duration_ms`                          |
| 67 (JSDoc) | `event.outcome`                                                   | `catalyst.event.outcome`                              |
| 73         | `this.fields['event.duration_ms']`                                | `this.fields['catalyst.event.duration_ms']`           |
| 74, 75     | `'event.outcome' in this.fields` / `this.fields['event.outcome']` | `'catalyst.event.outcome'`                            |
| 78         | `this.fields['event.outcome'] === 'failure'`                      | `this.fields['catalyst.event.outcome'] === 'failure'` |

**Renames in `middleware/wide-event.ts`:**

| Line | Old                                     | New                                              |
| ---- | --------------------------------------- | ------------------------------------------------ |
| 41   | `event.set('event.outcome', 'failure')` | `event.set('catalyst.event.outcome', 'failure')` |

- [ ] **Step 1: Update tests to expect new attribute names**

In `wide-event.unit.test.ts`, replace all occurrences:

- `'event.outcome'` → `'catalyst.event.outcome'` (as property keys and `.set()` args)
- `'event.duration_ms'` → `'catalyst.event.duration_ms'`

In `wide-event-middleware.unit.test.ts`, replace all occurrences:

- `'event.outcome'` → `'catalyst.event.outcome'`
- `'event.duration_ms'` → `'catalyst.event.duration_ms'`

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/telemetry && pnpm test:unit`
Expected: FAIL — tests expect new names, source still uses old names

- [ ] **Step 3: Update source files**

In `wide-event.ts`: replace `'event.outcome'` → `'catalyst.event.outcome'` and `'event.duration_ms'` → `'catalyst.event.duration_ms'` (leave `'event.name'` unchanged — it's standard OTel).

In `middleware/wide-event.ts`: replace `'event.outcome'` → `'catalyst.event.outcome'`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/telemetry && pnpm test:unit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
gt modify -c --no-interactive -m "refactor(telemetry): rename event.outcome/duration_ms to catalyst.event.* prefix"
```

---

### Task 2: Rename service lifecycle attributes

**Files:**

- Modify: `packages/service/src/catalyst-service.ts`
- Modify: `packages/service/src/catalyst-hono-server.ts`
- Modify: `packages/service/tests/lifecycle-logging.unit.test.ts`

**Renames:**

| File                          | Old                   | New                               |
| ----------------------------- | --------------------- | --------------------------------- |
| `catalyst-service.ts:117`     | `'event.duration_ms'` | `'catalyst.event.duration_ms'`    |
| `catalyst-service.ts:146`     | `'event.duration_ms'` | `'catalyst.event.duration_ms'`    |
| `catalyst-hono-server.ts:227` | `'event.duration_ms'` | `'catalyst.event.duration_ms'`    |
| `catalyst-hono-server.ts:228` | `'service.count'`     | `'catalyst.server.service_count'` |

- [ ] **Step 1: Update test to expect new names**

In `lifecycle-logging.unit.test.ts`: replace `'event.duration_ms'` → `'catalyst.event.duration_ms'` and `'service.count'` → `'catalyst.server.service_count'`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/service && pnpm test:unit`
Expected: FAIL

- [ ] **Step 3: Update source files**

In `catalyst-service.ts` and `catalyst-hono-server.ts`: replace attribute keys as specified above.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/service && pnpm test:unit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
gt modify -c --no-interactive -m "refactor(service): rename event.duration_ms/service.count to catalyst.* prefix"
```

---

## Chunk 2: Orchestrator V2

### Task 3: Rename v2 bus attributes

**Files:**

- Modify: `apps/orchestrator/src/v2/bus.ts`
- Modify: `apps/orchestrator/tests/v2-route-logging.unit.test.ts`

**Renames (WideEvent `.set()` calls):**

| Line | Old                      | New                                            |
| ---- | ------------------------ | ---------------------------------------------- |
| 70   | `'action.type'`          | `'catalyst.orchestrator.action.type'`          |
| 70   | `'node.name'`            | `'catalyst.orchestrator.node.name'`            |
| 79   | `'action.state_changed'` | `'catalyst.orchestrator.action.state_changed'` |
| 87   | `'action.state_changed'` | `'catalyst.orchestrator.action.state_changed'` |
| 88   | `'route.change_count'`   | `'catalyst.orchestrator.route.change_count'`   |
| 89   | `'route.total'`          | `'catalyst.orchestrator.route.total'`          |
| 100  | `'route.added'`          | `'catalyst.orchestrator.route.added'`          |
| 101  | `'route.removed'`        | `'catalyst.orchestrator.route.removed'`        |
| 102  | `'route.modified'`       | `'catalyst.orchestrator.route.modified'`       |
| 154  | `'peer.name'`            | `'catalyst.orchestrator.peer.name'`            |
| 154  | `'sync.type'`            | `'catalyst.orchestrator.sync.type'`            |
| 170  | `'peer.connected_count'` | `'catalyst.orchestrator.peer.connected_count'` |
| 171  | `'route.change_count'`   | `'catalyst.orchestrator.route.change_count'`   |

**Renames (logger property keys):**

| Line | Old                | New                                      |
| ---- | ------------------ | ---------------------------------------- |
| 106  | `'route.added'`    | `'catalyst.orchestrator.route.added'`    |
| 107  | `'route.removed'`  | `'catalyst.orchestrator.route.removed'`  |
| 108  | `'route.modified'` | `'catalyst.orchestrator.route.modified'` |
| 109  | `'route.trigger'`  | `'catalyst.orchestrator.route.trigger'`  |
| 110  | `'route.total'`    | `'catalyst.orchestrator.route.total'`    |
| 157  | `'peer.name'`      | `'catalyst.orchestrator.peer.name'`      |
| 183  | `'peer.name'`      | `'catalyst.orchestrator.peer.name'`      |
| 237  | `'peer.name'`      | `'catalyst.orchestrator.peer.name'`      |
| 246  | `'peer.name'`      | `'catalyst.orchestrator.peer.name'`      |
| 247  | `'route.count'`    | `'catalyst.orchestrator.route.count'`    |
| 253  | `'peer.name'`      | `'catalyst.orchestrator.peer.name'`      |
| 282  | `'peer.name'`      | `'catalyst.orchestrator.peer.name'`      |

- [ ] **Step 1: Update route-logging test to expect new names**

In `v2-route-logging.unit.test.ts`: replace `'route.added'` → `'catalyst.orchestrator.route.added'`, `'route.removed'` → `'catalyst.orchestrator.route.removed'`, `'route.modified'` → `'catalyst.orchestrator.route.modified'`, `'route.trigger'` → `'catalyst.orchestrator.route.trigger'`, `'route.total'` → `'catalyst.orchestrator.route.total'`, `'peer.name'` → `'catalyst.orchestrator.peer.name'`, `'route.count'` → `'catalyst.orchestrator.route.count'`.

- [ ] **Step 2: Update bus.ts source**

Apply all renames listed above. Use `replace_all` for each attribute key since they appear multiple times.

**Important:** Do NOT rename `'event.name'` keys or their values — only rename the custom attribute keys.

- [ ] **Step 3: Run tests**

Run: `cd apps/orchestrator && pnpm test:unit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
gt modify -c --no-interactive -m "refactor(orchestrator): rename v2 bus attributes to catalyst.orchestrator.* prefix"
```

---

### Task 4: Rename v2 transport attributes

**Files:**

- Modify: `apps/orchestrator/src/v2/ws-transport.ts`

**Renames:**

| Line | Old               | New                                     |
| ---- | ----------------- | --------------------------------------- |
| 72   | `'peer.name'`     | `'catalyst.orchestrator.peer.name'`     |
| 72   | `'peer.endpoint'` | `'catalyst.orchestrator.peer.endpoint'` |
| 93   | `'peer.name'`     | `'catalyst.orchestrator.peer.name'`     |
| 94   | `'peer.endpoint'` | `'catalyst.orchestrator.peer.endpoint'` |
| 135  | `'peer.name'`     | `'catalyst.orchestrator.peer.name'`     |

- [ ] **Step 1: Update ws-transport.ts**

Replace `'peer.name'` → `'catalyst.orchestrator.peer.name'` and `'peer.endpoint'` → `'catalyst.orchestrator.peer.endpoint'` (replace_all for each).

- [ ] **Step 2: Commit with Task 5 (below)**

---

### Task 5: Rename v2 reconnect attributes

**Files:**

- Modify: `apps/orchestrator/src/v2/reconnect.ts`
- Modify: `apps/orchestrator/tests/v2-peering-logging.unit.test.ts`

**Renames:**

| Line | Old                    | New                                          |
| ---- | ---------------------- | -------------------------------------------- |
| 53   | `'peer.name'`          | `'catalyst.orchestrator.peer.name'`          |
| 54   | `'reconnect.attempt'`  | `'catalyst.orchestrator.reconnect.attempt'`  |
| 55   | `'reconnect.delay_ms'` | `'catalyst.orchestrator.reconnect.delay_ms'` |
| 63   | `'peer.name'`          | `'catalyst.orchestrator.peer.name'`          |
| 72   | `'peer.name'`          | `'catalyst.orchestrator.peer.name'`          |
| 73   | `'reconnect.attempt'`  | `'catalyst.orchestrator.reconnect.attempt'`  |
| 84   | `'peer.name'`          | `'catalyst.orchestrator.peer.name'`          |
| 85   | `'reconnect.attempt'`  | `'catalyst.orchestrator.reconnect.attempt'`  |

- [ ] **Step 1: Update peering-logging test to expect new names**

In `v2-peering-logging.unit.test.ts`: replace `'reconnect.attempt'` → `'catalyst.orchestrator.reconnect.attempt'`, `'reconnect.delay_ms'` → `'catalyst.orchestrator.reconnect.delay_ms'`, `'peer.name'` → `'catalyst.orchestrator.peer.name'`.

- [ ] **Step 2: Update reconnect.ts**

Replace all dotted attribute keys with `catalyst.orchestrator.*` prefix.

- [ ] **Step 3: Run tests**

Run: `cd apps/orchestrator && pnpm test:unit`
Expected: PASS

- [ ] **Step 4: Commit (Tasks 4 + 5 together)**

```bash
gt modify -c --no-interactive -m "refactor(orchestrator): rename v2 transport/reconnect attributes to catalyst.orchestrator.* prefix"
```

---

### Task 6: Rename v2 RPC and catalyst-service attributes

**Files:**

- Modify: `apps/orchestrator/src/v2/rpc.ts`
- Modify: `apps/orchestrator/src/v2/catalyst-service.ts`

**Renames in `rpc.ts`:**

| Line | Old           | New                                 |
| ---- | ------------- | ----------------------------------- |
| 204  | `'jwt.sub'`   | `'catalyst.orchestrator.jwt.sub'`   |
| 205  | `'peer.name'` | `'catalyst.orchestrator.peer.name'` |
| 243  | `'jwt.sub'`   | `'catalyst.orchestrator.jwt.sub'`   |

**Renames in `catalyst-service.ts`:**

| Line | Old               | New                                     | Notes                              |
| ---- | ----------------- | --------------------------------------- | ---------------------------------- |
| 171  | `'node.name'`     | `'catalyst.orchestrator.node.name'`     |                                    |
| 225  | `'error.type'`    | —                                       | **KEEP** — standard OTel attribute |
| 258  | `'auth.endpoint'` | `'catalyst.orchestrator.auth.endpoint'` |                                    |
| 288  | `'node.name'`     | `'catalyst.orchestrator.node.name'`     |                                    |

- [ ] **Step 1: Update rpc.ts and catalyst-service.ts**

Apply renames. Leave `'error.type'` unchanged (standard OTel).

- [ ] **Step 2: Run tests**

Run: `cd apps/orchestrator && pnpm test:unit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
gt modify -c --no-interactive -m "refactor(orchestrator): rename v2 rpc/service attributes to catalyst.orchestrator.* prefix"
```

---

## Chunk 3: Orchestrator V1 (Legacy)

### Task 7: Rename v1 orchestrator attributes

**Files:**

- Modify: `apps/orchestrator/src/v1/orchestrator.ts`

**Renames (WideEvent `.set()` call at line 235):**

| Old             | New                                   |
| --------------- | ------------------------------------- |
| `'action.type'` | `'catalyst.orchestrator.action.type'` |
| `'node.name'`   | `'catalyst.orchestrator.node.name'`   |

Logger property key renames (where dotted custom attribute keys are used):

| Old           | New                                                            |
| ------------- | -------------------------------------------------------------- |
| `'peer.name'` | `'catalyst.orchestrator.peer.name'` (if present as dotted key) |

Note: Most v1 logger calls use simple keys (`peer:`, `count:`, `route:`) for template interpolation — these are NOT OTel attribute names and should NOT be renamed. Only rename explicitly dotted keys that follow the `'namespace.property'` pattern.

- [ ] **Step 1: Update v1/orchestrator.ts**

Replace `'action.type'` → `'catalyst.orchestrator.action.type'` and `'node.name'` → `'catalyst.orchestrator.node.name'` in the WideEvent `.set()` call.

Scan for any `'peer.name':` dotted keys in logger calls and rename those too.

- [ ] **Step 2: Run tests**

Run: `cd apps/orchestrator && pnpm test:unit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
gt modify -c --no-interactive -m "refactor(orchestrator): rename v1 attributes to catalyst.orchestrator.* prefix"
```

---

## Chunk 4: Verification

### Task 8: Full test suite verification

- [ ] **Step 1: Run full workspace unit tests**

Run: `pnpm -r test:unit`
Expected: ALL PASS

- [ ] **Step 2: Run typecheck**

Run: `pnpm -r typecheck`
Expected: ALL PASS

- [ ] **Step 3: Grep audit — confirm no remaining un-prefixed custom attributes**

Run: `grep -rn "'action\.\|'peer\.\|'route\.\|'sync\.\|'reconnect\.\|'node\.name\|'auth\.endpoint\|'jwt\.sub\|'service\.count'" --include='*.ts' apps/orchestrator/src packages/telemetry/src packages/service/src | grep -v 'event.name' | grep -v 'node_modules'`

Expected: No hits (all custom attrs now prefixed with `catalyst.`). Standard OTel attributes (`error.type`) are OK to appear.

- [ ] **Step 4: Final commit if any fixups needed**

```bash
gt modify -c --no-interactive -m "refactor: finalize OTel attribute naming alignment"
```
