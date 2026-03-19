# WideEvent Guaranteed Emission Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guarantee WideEvent emission on all code paths by introducing a `withWideEvent` wrapper and migrating all 21 usage sites.

**Architecture:** Add `withWideEvent<T>` helper to `@catalyst/telemetry` that wraps a callback in try/catch/finally, guaranteeing `.setError()` on exception and `.emit()` always. Migrate every `new WideEvent()` / `.emit()` pair across the codebase to use the wrapper.

**Tech Stack:** TypeScript, `@catalyst/telemetry`, vitest

---

## Chunk 1: Helper + Tests

### Task 1: Add `withWideEvent` helper and tests

**Files:**

- Modify: `packages/telemetry/src/wide-event.ts`
- Modify: `packages/telemetry/src/index.ts`
- Create: `packages/telemetry/tests/with-wide-event.test.ts`

- [ ] **Step 1: Add `withWideEvent` function** to `packages/telemetry/src/wide-event.ts`
- [ ] **Step 2: Export from index** — add `withWideEvent` to `packages/telemetry/src/index.ts`
- [ ] **Step 3: Write tests** — emit on success, emit+setError on throw, error re-thrown, return value passed through
- [ ] **Step 4: Run tests** — `pnpm --filter "@catalyst/telemetry" test`
- [ ] **Step 5: Commit** — `feat(telemetry): add withWideEvent guaranteed-emission helper`

## Chunk 2: Migrate orchestrator bus (5 sites)

### Task 2: Migrate `bus.ts`

**Files:**

- Modify: `apps/orchestrator/src/v2/bus.ts`

5 WideEvent sites:

1. `orchestrator.action` (dispatch) — unprotected
2. `orchestrator.peer_sync` (handleBGPNotify) — unprotected
3. `orchestrator.route_propagation` (handleBGPNotify) — **missing emit (bug)**
4. `orchestrator.gateway_sync` (handleGraphqlGatewaySync) — protected
5. `orchestrator.envoy_sync` (handleEnvoySync) — protected

- [ ] **Step 1: Migrate all 5 sites** to `withWideEvent`
- [ ] **Step 2: Run tests** — `pnpm --filter "@catalyst/orchestrator-service" exec vitest run tests/v2/`
- [ ] **Step 3: Commit** — `fix(orchestrator): migrate bus.ts WideEvent sites to withWideEvent`

## Chunk 3: Migrate orchestrator RPC + transports (6 sites)

### Task 3: Migrate `rpc.ts`, `ws-transport.ts`, `http-transport.ts`

**Files:**

- Modify: `apps/orchestrator/src/v2/rpc.ts`
- Modify: `apps/orchestrator/src/v2/ws-transport.ts`
- Modify: `apps/orchestrator/src/v2/http-transport.ts`

- [ ] **Step 1: Migrate rpc.ts** (3 sites: network, datachannel, ibgp auth)
- [ ] **Step 2: Migrate ws-transport.ts** (1 site: openPeer)
- [ ] **Step 3: Migrate http-transport.ts** (2 sites: openPeer, closePeer)
- [ ] **Step 4: Run tests** — `pnpm --filter "@catalyst/orchestrator-service" exec vitest run tests/v2/`
- [ ] **Step 5: Commit** — `fix(orchestrator): migrate rpc/transport WideEvent sites to withWideEvent`

## Chunk 4: Migrate remaining sites (7 sites)

### Task 4: Migrate catalyst-service, compaction, service, v1, envoy, gateway, middleware

**Files:**

- Modify: `apps/orchestrator/src/v2/catalyst-service.ts` (2 sites)
- Modify: `apps/orchestrator/src/v2/compaction.ts` (1 site)
- Modify: `apps/orchestrator/src/v2/service.ts` (1 site)
- Modify: `apps/orchestrator/src/v1/orchestrator.ts` (1 site)
- Modify: `apps/envoy/src/rpc/server.ts` (1 site)
- Modify: `apps/gateway/src/graphql/server.ts` (1 site)

Note: The HTTP middleware (`packages/telemetry/src/middleware/wide-event.ts`) is a special case — it exposes the WideEvent to downstream handlers via `c.set('wideEvent', event)`. This stays as-is since the middleware IS the try/finally wrapper for HTTP requests.

- [ ] **Step 1: Migrate all 7 sites**
- [ ] **Step 2: Run full test suite** — routing + orchestrator v2
- [ ] **Step 3: Commit** — `fix: migrate remaining WideEvent sites to withWideEvent`
