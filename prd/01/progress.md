# PRD Progress Tracking

**PRD:** Catalyst Node POC — GraphQL Parity (v1.0.0)
**Last Updated:** 2026-02-10
**Overall POC Readiness:** ~95%

---

## Progress Summary

| Requirement                           | Status      | Completion | Priority Gaps                               |
| ------------------------------------- | ----------- | ---------- | ------------------------------------------- |
| FR-1: GraphQL Federation              | ✅ COMPLETE | 100%       | None                                        |
| FR-2: Cross-Organization Data Sharing | ✅ COMPLETE | 100%       | None                                        |
| FR-3: Authentication & Authorization  | ✅ COMPLETE | 100%       | None                                        |
| FR-4: Observability                   | ✅ COMPLETE | 95%        | Key-manager console.log cleanup (low)       |
| FR-5: Docker Compose Deployment       | ⚠️ PARTIAL  | 90%        | Multi-arch builds, single-command bootstrap |

---

## FR-1: GraphQL Federation ✅

### Requirements Checklist

- [x] Register local GraphQL services via CLI or API
- [x] Gateway stitches registered service schemas into unified schema
- [x] Queries against unified schema delegate to correct upstream service
- [x] Zero-downtime schema reload when services are added or removed

### Implementation Status

| Requirement               | Implementation               | Files                                   |
| ------------------------- | ---------------------------- | --------------------------------------- |
| Register services via CLI | `catalyst node route create` | `apps/cli/src/commands/node/route.ts`   |
| Register services via API | `DataChannel.addRoute()`     | `apps/orchestrator/src/orchestrator.ts` |
| Schema stitching          | `@graphql-tools/stitch`      | `apps/gateway/src/graphql/server.ts`    |
| Query delegation          | AsyncExecutor per-service    | `apps/gateway/src/graphql/server.ts`    |
| Zero-downtime reload      | RPC `updateConfig()`         | `apps/gateway/src/rpc/server.ts`        |

---

## FR-2: Cross-Organization Data Sharing ✅

### Requirements Checklist

- [x] Add peer node via CLI
- [x] Route updates propagated to peers
- [x] Route withdrawal on peer disconnection
- [x] Peered services appear in local Gateway federation

### Implementation Status

| Requirement        | Implementation                            | Files                                   |
| ------------------ | ----------------------------------------- | --------------------------------------- |
| Add peer via CLI   | `catalyst node peer create`               | `apps/cli/src/commands/node/peer.ts`    |
| Route propagation  | BGP-style with `nodePath` loop prevention | `apps/orchestrator/src/orchestrator.ts` |
| Route withdrawal   | `propagateWithdrawalsForPeer()`           | `apps/orchestrator/src/orchestrator.ts` |
| Gateway federation | Internal routes synced to gateway         | `apps/orchestrator/src/orchestrator.ts` |

---

## FR-3: Authentication & Authorization ✅

### Requirements Checklist

- [x] Self-contained authorization
- [x] JWKS endpoint for key distribution
- [x] Key rotation
- [x] Token revocation (persistent store)

### Implementation Status

| Requirement         | Status | Implementation                | Files                                                  |
| ------------------- | ------ | ----------------------------- | ------------------------------------------------------ |
| Self-contained auth | ✅     | Cedar WASM policies           | `packages/authorization/`                              |
| JWKS endpoint       | ✅     | `/.well-known/jwks.json`      | `apps/auth/src/service.ts`                             |
| Key rotation        | ✅     | Graceful + immediate rotation | `packages/authorization/src/key-manager/persistent.ts` |
| Token revocation    | ✅     | SQLite persistent store       | `packages/authorization/src/jwt/local/sqlite-store.ts` |

### Notes

- Token revocation upgraded from `InMemoryRevocationStore` to `BunSqliteTokenStore` (SQLite-backed)
- Satisfies ADR-0004 requirement that "token revocations must survive restarts"
- JWKS endpoint includes `Cache-Control: public, max-age=300` headers
- Key rotation supports both graceful (24h grace period) and immediate modes

---

## FR-4: Observability ✅

### Requirements Checklist

- [x] Replace console.log with LogTape structured logging
- [x] Metrics (OTEL/Prometheus)
- [x] Traces (OTEL)
- [x] OTEL Collector in compose
- [x] Debug/file export backend

### Implementation Status

| Requirement         | Status | Notes                                                      |
| ------------------- | ------ | ---------------------------------------------------------- |
| LogTape logging     | ✅     | All services migrated via CatalystService + getLogger      |
| Metrics             | ✅     | `@catalyst/telemetry` - HTTP + RPC histograms via OTel SDK |
| Traces              | ✅     | Distributed traces with W3C traceparent propagation        |
| OTEL Collector      | ✅     | In all compose files (debug exporter, ready for backends)  |
| Debug backend       | ✅     | Collector debug exporter outputs to stdout                 |
| RPC instrumentation | ✅     | Proxy-based capnweb span creation + transport propagation  |

### Key Implementation Details

**Package:** `packages/telemetry/` (`@catalyst/telemetry`)

| Component              | File                                                     |
| ---------------------- | -------------------------------------------------------- |
| TelemetryBuilder       | `packages/telemetry/src/builder.ts`                      |
| LogTape configuration  | `packages/telemetry/src/logger.ts`                       |
| Metrics (OTel SDK)     | `packages/telemetry/src/metrics.ts`                      |
| Traces (OTel SDK)      | `packages/telemetry/src/instrumentation.ts`              |
| HTTP middleware (Hono) | `packages/telemetry/src/middleware/hono.ts`              |
| RPC instrumentation    | `packages/telemetry/src/middleware/capnweb.ts`           |
| Trace propagation      | `packages/telemetry/src/middleware/capnweb-transport.ts` |

**Integration:** All services inherit telemetry automatically via `CatalystService` base class (ADR-0010).

**Logging migration status:**

- Orchestrator: ✅ 47 console calls replaced with LogTape
- Gateway: ✅ Startup marker removed, GraphQL server uses LogTape
- Auth: ✅ RPC server uses getAuthLogger, permissions uses LogTape
- Node: ✅ Stubs migrated to getLogger
- CatalystHonoServer: ✅ Startup message uses getLogger
- AuthorizationEngine: ✅ Validation output uses getLogger
- CLI: N/A (intentional user-facing console output via chalk)
- Examples: N/A (standalone demo apps)
- Remaining: `packages/authorization/src/key-manager/persistent.ts` (8 calls, low priority)

**Backend exporters:** Deferred per ADR-0003. Collector infrastructure is ready — just add Jaeger/Prometheus/Loki exporters to `otel-collector-config.yaml`.

---

## FR-5: Docker Compose Deployment ⚠️

### Requirements Checklist

- [ ] Single docker compose up ⚠️
- [x] Health checks on all services
- [x] Example services included
- [x] OTEL Collector included
- [x] Documented config variables
- [ ] Multi-arch images ❌

### Implementation Status

| Requirement          | Status     | Notes                                                    |
| -------------------- | ---------- | -------------------------------------------------------- |
| Single compose up    | ⚠️ PARTIAL | M0P2 requires manual token extraction; dev compose works |
| Health checks        | ✅         | All services in all 3 compose files                      |
| Example services     | ✅         | books + movies in all compose files                      |
| OTEL Collector       | ✅         | In docker.compose + two-node.compose with config         |
| Config documentation | ✅         | docker-compose/README.md with env var reference          |
| Multi-arch images    | ❌         | No buildx/multi-platform config                          |

### Compose Files

| File                        | Purpose             | Services | Health Checks |
| --------------------------- | ------------------- | -------- | ------------- |
| `docker.compose.yaml`       | Single-node dev     | 6        | ✅ All        |
| `two-node.compose.yaml`     | Multi-node topology | 9        | ✅ All        |
| `example.m0p2.compose.yaml` | M0P2 bootstrap      | 5        | ✅ All        |

### Remaining Gaps

#### Medium Priority: Multi-Arch Images

**Status:** NOT IMPLEMENTED
**Severity:** MEDIUM (blocks Raspberry Pi 5 requirement)

**Implementation Needed:**

- Configure `docker buildx` for multi-platform builds (`linux/amd64` + `linux/arm64`)
- Update Dockerfiles if needed for ARM64 compatibility
- Add CI/CD pipeline for multi-arch image publishing
- Verify on Raspberry Pi 5

#### Low Priority: Single-Command Deployment

**Status:** PARTIAL
**Severity:** LOW (dev compose already works, only M0P2 example needs token extraction)

The `docker.compose.yaml` and `two-node.compose.yaml` work with a single `docker compose up`. Only `example.m0p2.compose.yaml` requires manual token extraction due to the bootstrap flow.

---

## Priority Implementation Order (Updated)

### Completed ✅

1. ~~Create `@catalyst/telemetry` package~~ — Done
2. ~~Add OTEL Collector to compose~~ — Done
3. ~~Implement SqliteRevocationStore~~ — Done (BunSqliteTokenStore)
4. ~~Migrate console.log to LogTape~~ — Done (all services)
5. ~~Add compose health checks~~ — Done (all 3 files)
6. ~~Complete config documentation~~ — Done (README)

### Remaining

7. **Configure multi-arch builds** — Enable Raspberry Pi 5 deployment (MEDIUM)
8. **Automate token bootstrap** — True single-command deployment for M0P2 (LOW)

---

## Change Log

| Date       | Change                                                | Updated By        |
| ---------- | ----------------------------------------------------- | ----------------- |
| 2026-02-05 | Initial audit completed                               | Claude Sonnet 4.5 |
| 2026-02-10 | Re-audit: FR-3 100%, FR-4 95%, FR-5 90%, overall ~95% | Claude Opus 4.6   |
