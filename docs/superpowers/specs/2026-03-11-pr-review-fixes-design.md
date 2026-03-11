# PR Review Fixes — Design Spec

Addresses unresolved review feedback across PRs #506, #510, #511, #522, #561.

## Items

### 1. Rename `latencyMs` to `durationMs` (PR #506)

**File:** `apps/orchestrator/src/routes/dashboard.ts`

`performance.now()` measures wall-clock elapsed time for a `fetch()` health check. The field is named `latencyMs` but the reviewer correctly notes this isn't pure network latency — it includes event loop delay, DNS, TLS, server processing, etc. Rename to `durationMs` for accuracy and consistency with OTel conventions.

**Changes:**

- Rename `latencyMs` to `durationMs` in `ServiceHealth` interface (line 28)
- Update both assignments in `checkHealth()` (lines 96, 102)

### 2. Make `getState()` return an immutable copy (PR #506)

**File:** `apps/orchestrator/src/v1/orchestrator.ts`

`getState()` (line 1072) is documented as "Read-only snapshot" but returns `this.state` directly. Callers can mutate the route table, bypassing `dispatch()`. The route table has nested objects (`local.routes`, `internal.peers`, `internal.routes`) so a shallow freeze is insufficient.

**Fix:** Return `structuredClone(this.state)`. The dashboard API is low-frequency (human-driven UI polling) so the allocation cost is negligible.

### 3. Warn when envoy config is missing (PR #506)

**File:** `apps/orchestrator/src/routes/dashboard.ts`

The dashboard conditionally includes envoy-service based on `config.orchestrator?.envoyConfig?.endpoint`. The reviewer feels this is brittle because `loadDefaultConfig` doesn't enforce envoy existence. The dashboard already degrades gracefully (filters empty groups), but operators get no visibility that envoy is absent.

**Fix:** Add a warning log in `createDashboardRoutes()` when `envoyConfig` is not present. The question of whether to make envoy required in config validation is deferred — that's a broader architectural decision.

### 4. Move `process.env` reads to route setup time (PR #506)

**File:** `apps/orchestrator/src/routes/dashboard.ts`

`deriveServiceGroups()` reads `process.env.OTEL_SERVICE_NAME` (line 49) and `process.env.CATALYST_AUTH_ENDPOINT` (line 55) on every API call. Env vars should be resolved once at init, not at runtime.

**Fix:** Read both env vars at the top of `createDashboardRoutes()` and pass them into `deriveServiceGroups()` as parameters. Two lines move up, function signature gets two new params.

### 5. Remove `user: root` from auth in compose (PR #511)

**File:** `docker-compose/two-node.compose.yaml`

The auth Dockerfile creates a non-root `appuser` (line 64-66) but the compose file overrides with `user: root` (line 23) because Docker creates named volumes as root-owned. This defeats the Dockerfile's security hardening.

**Fix:** Add an entrypoint script that starts as root, fixes volume ownership, then drops to `appuser`:

```sh
#!/bin/sh
chown appuser:appgroup /data
exec su-exec appuser node server.mjs
```

Update the Dockerfile to install `su-exec` (Alpine package) and copy the entrypoint. Remove `user: root` from the compose file.

### 6. Extract observability stack to compose overlay (PR #511)

**Files:** `docker-compose/two-node.compose.yaml`, `docker-compose/docker.compose.yaml`

The observability services (prometheus, jaeger, loki, grafana) are embedded in both `docker.compose.yaml` and `two-node.compose.yaml`. Reviewer wants them independent. Same pattern as `aspire.compose.yaml`.

**Fix:** Create `docker-compose/observability.compose.yaml` containing:

- prometheus
- jaeger
- loki
- grafana
- grafana provisioning volume mounts

The otel-collector stays in the base compose files (needed for app telemetry). The observability overlay is added with `-f observability.compose.yaml`. This also solves the duplication concern (item #7) — one source of truth for observability config.

Both `docker.compose.yaml` and `two-node.compose.yaml` get their observability services removed.

## Items Not Actioned

| Item                               | Reason                                                                                                                                                                                                                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR #510 `process.env.FRONTEND_DIR` | Already resolved by web-ui extraction (PR #534)                                                                                                                                                                                                                        |
| PR #522 holocrons subskill         | Process concern, already replied to by author                                                                                                                                                                                                                          |
| PR #561 `otlp_grpc` naming         | Reviewer wrong — `otlp_grpc` is the canonical name as of collector v0.144.0 ([release notes](https://github.com/open-telemetry/opentelemetry-collector/releases/tag/v0.144.0), [issue #14099](https://github.com/open-telemetry/opentelemetry-collector/issues/14099)) |
| PR #506 "GQL doesn't matter"       | Informational comment, no action needed                                                                                                                                                                                                                                |
