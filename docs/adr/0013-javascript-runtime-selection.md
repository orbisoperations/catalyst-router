# ADR-0013: JavaScript Runtime Selection — Bun to Node.js Migration

**Status:** Proposed
**Date:** 2026-02-18
**Decision Owner(s):** Platform Team

## Context

Catalyst has used Bun as its JavaScript runtime since inception. This was never
formally documented in an ADR — Bun was adopted as an implicit foundational
choice, and subsequent ADRs (0001, 0002, 0004, 0010, 0011, 0012) all treat it
as a given.

That choice now constrains the system's ability to adopt post-quantum
cryptography (PQC) natively:

- **Bun bundles BoringSSL** which does NOT expose PQ key exchange groups
  (`X25519MLKEM768`) or PQ signature algorithms (ML-DSA). Bun GitHub issue
  [#18332](https://github.com/oven-sh/bun/issues/18332) has zero maintainer
  engagement and no roadmap.
- **ADR 0012 was written around this gap** — Envoy terminates TLS specifically
  because Bun cannot do PQ. While the Envoy decision remains architecturally
  sound, coupling it to a runtime limitation is fragile.
- **Node.js 24 LTS (v24.13.1)** ships with OpenSSL 3.5, providing native
  ML-KEM (FIPS 203), ML-DSA (FIPS 204), and X25519MLKEM768 hybrid key exchange
  in TLS 1.3 — all out of the box.

Additionally, the planned YubiKey PKCS#11 signing backend depends on
`node-webcrypto-p11`, a native N-API module tested against Node.js (not Bun).

### Current State

- All services use `Bun.serve()` for HTTP (18 files, 40 uses)
- All tests use `bun:test` (77 test files)
- Three SQLite store classes use `bun:sqlite`
- Nine files use `hono/bun` for WebSocket (RPC-over-WebSocket via capnweb)
- Eight files use `Bun.spawn/spawnSync` (mostly container tests)
- Bun tooling (`bun install`, workspaces, lockfile) manages the monorepo

### Requirements

| Requirement                                | Priority | Notes                                             |
| ------------------------------------------ | -------- | ------------------------------------------------- |
| Native PQ key exchange (X25519MLKEM768)    | Must     | CNSA 2.0 compliance path                          |
| Native PQ signatures (ML-DSA)              | Must     | PQ certificate signing (ADR 0011 Phase 2)         |
| PKCS#11 support for hardware-backed crypto | Should   | YubiKey signing backend for local deployments     |
| WebSocket RPC compatibility                | Must     | capnweb RPC is the primary inter-service protocol |
| Minimal disruption to existing code        | Should   | Incremental migration, not a rewrite              |
| Retain fast package management             | Should   | Bun install is best-in-class                      |

## Decision

**Chosen Option: Hybrid — Bun tooling + Node.js runtime**

Use Bun for package management, workspace resolution, and bundling. Use Node.js
as the runtime for all services. This gives us native PQC via OpenSSL 3.5 while
retaining Bun's tooling advantages.

### Rationale

1. **Native PQC today** — Node.js 24 LTS provides ML-KEM, ML-DSA, and
   X25519MLKEM768 in TLS 1.3 out of the box. No external libraries, no WASM
   shims, no waiting for Bun's roadmap.
2. **PQ certificate signing unlocked** — ML-DSA via `crypto.sign()` enables
   the ADR 0011 Phase 2 PQ algorithm roadmap natively. This was previously
   blocked on ecosystem maturity.
3. **PKCS#11 compatibility** — `node-webcrypto-p11` (PeculiarVentures, N-API)
   is tested on Node.js and integrates with `@peculiar/x509` for YubiKey
   hardware-backed CA signing.
4. **Bun tooling is separable** — `bun install` produces standard `node_modules/`
   that Node.js consumes. Workspaces, lockfile, and dependency catalog are
   unaffected. No CI/CD changes for dependency management.
5. **Ecosystem maturity** — Node.js 24 LTS is supported until April 2028.
   OpenTelemetry SDK, native addons, and the npm ecosystem are tested against
   Node.js as a first-class target.
6. **Envoy becomes a choice, not a constraint** — ADR 0012's Envoy TLS pattern
   is still the recommended architecture, but its rationale shifts from "Bun
   can't do PQ" to "Envoy provides the best operational model." This is a
   healthier architectural position.

### Trade-offs Accepted

- **Performance regression** — Bun is ~2-4x faster than Node.js for raw HTTP
  throughput and uses ~50% less memory. This is a real cost for high-throughput
  scenarios. Mitigation: Envoy handles the data plane; Node.js services are
  primarily control plane with moderate throughput requirements.
- **Migration effort** — ~117 files across the monorepo require changes (mostly
  mechanical import swaps). Estimated ~39 hours of work, split across 5 stacked
  PRs.
- **Native addon compilation** — `better-sqlite3` requires native compilation
  (prebuilt binaries available for common platforms). This adds a build
  dependency that `bun:sqlite` did not have.
- **WebSocket initialization change** — `@hono/node-ws` uses a different
  initialization pattern (post-start injection) vs `hono/bun` (constructor
  option). The `CatalystHonoServer` abstraction needs refactoring.

## Consequences

### Positive

- Native PQ key exchange and signatures without external libraries
- ADR 0011 Phase 2 (PQ cert signing) becomes immediately achievable
- YubiKey PKCS#11 backend has a tested, supported path
- OpenTelemetry is officially supported (vs "works on Bun but not officially")
- Envoy TLS pattern remains but is now merit-based, not constraint-driven
- Simple-mode deployments (no Envoy) become architecturally possible for
  single-node / development scenarios

### Negative

- HTTP throughput reduction (~2-4x slower than Bun for raw benchmarks)
- Memory usage increase (~2x compared to Bun)
- Native addon compilation for `better-sqlite3` (prebuilds mitigate this)
- WebSocket adapter change requires `CatalystHonoServer` refactoring

### Neutral

- Test runner changes from `bun:test` to `vitest` (API-compatible, already in
  dependency catalog)
- `child_process` replaces `Bun.spawn` (equivalent API, built into Node.js)
- Bun remains as the package manager / monorepo tooling — no CI changes

## Implementation

### Migration Phases (Graphite stacked PRs)

Each phase is a separate branch/PR for small, reviewable changes:

**Phase 1: `docs/adr-0013-runtime-evaluation`** (this PR)

- ADR 0013 document
- README index update
- Amendments to affected ADRs (0004, 0010, 0011, 0012)

**Phase 2: `migrate/test-runner-vitest`**

- Replace `import { ... } from 'bun:test'` with `import { ... } from 'vitest'` (77 files)
- Add `vitest.config.ts` (replace `bunfig.toml` test config)
- Update `mock()` / `spyOn()` to `vi.fn()` / `vi.spyOn()` where used
- Update `package.json` scripts: `bun test` → `vitest`

**Phase 3: `migrate/sqlite-better-sqlite3`**

- Add `better-sqlite3` to dependencies
- Update 3 store classes:
  - `db.query(sql)` → `db.prepare(sql)`
  - `db.run(sql, params)` → `db.prepare(sql).run(params)`
- Update import: `from 'bun:sqlite'` → `from 'better-sqlite3'`

**Phase 4: `migrate/server-hono-node`**

- Replace `Bun.serve()` with `@hono/node-server` `serve()`
- Replace `hono/bun` WebSocket with `@hono/node-ws`
- Refactor `CatalystHonoServer` for Node.js server lifecycle
- Update `ReturnType<typeof Bun.serve>` type annotations (17 occurrences)

**Phase 5: `migrate/process-spawn`**

- Replace `Bun.spawn/spawnSync` with `child_process.spawn/spawnSync` (8 files)
- Update container test helpers

**Phase 6: `migrate/cleanup`**

- Remove `bunfig.toml`
- Update `Bun.main` check → `import.meta.url` comparison (1 file)
- Update Dockerfiles: `bun run` → `node`
- Audit for any remaining `Bun.*` references

### Migration Scope

| Bun API                        | Files | Node.js Replacement    | In catalog? |
| ------------------------------ | ----- | ---------------------- | ----------- |
| `bun:test`                     | 77    | `vitest`               | Yes         |
| `Bun.serve()`                  | 18    | `@hono/node-server`    | Yes         |
| `bun:sqlite`                   | 3     | `better-sqlite3`       | Add         |
| `hono/bun` (WebSocket)         | 9     | `@hono/node-ws`        | Add         |
| `Bun.spawn/spawnSync`          | 8     | `child_process`        | Built-in    |
| `Bun.main`                     | 1     | `import.meta.url`      | Built-in    |
| `bunfig.toml`                  | 1     | `vitest.config.ts`     | —           |
| `ReturnType<typeof Bun.serve>` | 17    | Node.js `Server` types | Built-in    |

## Risks and Mitigations

| Risk                                  | Likelihood | Impact | Mitigation                                                         |
| ------------------------------------- | ---------- | ------ | ------------------------------------------------------------------ |
| Performance regression under load     | Medium     | Medium | Envoy handles data plane; control plane throughput is moderate     |
| WebSocket RPC incompatibility         | Low        | High   | `@hono/node-ws` uses same `upgradeWebSocket` signature; test early |
| `better-sqlite3` prebuilt unavailable | Low        | Low    | Falls back to source compilation; CI has build tools               |
| Bun workspace resolution breaks Node  | Low        | Low    | Bun produces standard `node_modules/` layout; well-documented      |
| OpenSSL 3.5 PQ API changes            | Low        | Medium | Node 24 LTS is stable; OpenSSL 3.5 APIs are NIST-standardized      |

## Impact on Existing ADRs

| ADR  | Title                       | Impact | Change                                                             |
| ---- | --------------------------- | ------ | ------------------------------------------------------------------ |
| 0001 | OpenTelemetry Observability | Low    | "Bun compatibility" concern resolved; OTEL is officially supported |
| 0002 | Logging Library Selection   | Low    | "Must work on Bun" → "Must work on Node.js"; decision unchanged    |
| 0004 | SQLite Storage Backend      | High   | `bun:sqlite` → `better-sqlite3`; decision (SQLite) unchanged       |
| 0010 | Catalyst Service Base Class | Medium | `Bun.serve()` → `@hono/node-server`; abstraction unchanged         |
| 0011 | PKI Hierarchy               | High   | PQ roadmap accelerates; ML-DSA available natively for Phase 2      |
| 0012 | Envoy TLS Termination       | High   | Rationale shifts from constraint-driven to merit-driven            |

Each affected ADR will receive an amendment note referencing this ADR.

## Related Decisions

- [ADR-0004](./0004-sqlite-storage-backend.md) — SQLite implementation changes
- [ADR-0010](./0010-catalyst-service-base-class.md) — Server binding changes
- [ADR-0011](./0011-pki-hierarchy-and-certificate-profiles.md) — PQ roadmap accelerates
- [ADR-0012](./0012-envoy-tls-termination-pq-readiness.md) — Rationale reframing

## References

- [Node.js 24.7.0 release notes — PQC APIs](https://nodejs.org/en/blog/release/v24.7.0)
- [OpenSSL 3.5.0 — native PQC support](https://www.helpnetsecurity.com/2025/04/09/openssl-3-5-0-released/)
- [Bun issue #18332 — Quantum secure crypto library (no response)](https://github.com/oven-sh/bun/issues/18332)
- [NIST FIPS 203 — ML-KEM](https://csrc.nist.gov/pubs/fips/203/final)
- [NIST FIPS 204 — ML-DSA](https://csrc.nist.gov/pubs/fips/204/final)
- [CNSA 2.0 Algorithm Suite](https://media.defense.gov/2022/Sep/07/2003071834/-1/-1/0/CSA_CNSA_2.0_ALGORITHMS_.PDF)
- [@hono/node-ws — WebSocket adapter for Node.js](https://github.com/honojs/middleware/tree/main/packages/node-ws)
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)
- [node-webcrypto-p11](https://github.com/AiryHalf/node-webcrypto-p11)

---

## Appendix: Options Considered

<details>
<summary>Click to expand full options analysis</summary>

### Option 1: Stay on Bun

Continue using Bun as the runtime. Accept that PQ is only available through
Envoy and wait for Bun to add PQ support.

**Approach:**

- Keep all existing code unchanged
- Rely on Envoy for all PQ TLS (ADR 0012 status quo)
- Monitor Bun issue #18332 for progress

**Pros:**

- Zero migration effort
- Retain Bun's performance advantage (2-4x HTTP, 50% memory)
- No risk of introducing regressions

**Cons:**

- PQ is blocked on Bun's roadmap (no engagement from maintainers)
- Cannot do PQ certificate signatures (ML-DSA) — blocks ADR 0011 Phase 2
- YubiKey PKCS#11 untested on Bun's N-API implementation
- Architecture remains constrained by runtime limitations
- CNSA 2.0 compliance path depends on a third-party roadmap we don't control

### Option 2: Hybrid — Bun tooling + Node.js runtime (chosen)

Keep Bun for package management, workspaces, and bundling. Switch the runtime
to Node.js for all services.

**Approach:**

- `bun install` / `bun add` / workspaces unchanged
- `node` replaces `bun run` for service execution
- Mechanical migration of Bun-specific APIs (~117 files)
- 5 stacked PRs, each independently testable

**Pros:**

- Native PQC (ML-KEM, ML-DSA, X25519MLKEM768)
- Best-in-class package management retained
- Incremental migration — no big bang
- PKCS#11 and OTEL officially supported

**Cons:**

- Performance regression (2-4x HTTP throughput, 2x memory)
- ~39 hours migration effort
- Native compilation needed for `better-sqlite3`

### Option 3: Full Node.js (runtime + tooling)

Replace Bun entirely — use npm/pnpm for package management and Node.js as
runtime.

**Approach:**

- Replace `bun install` with `pnpm install` or `npm install`
- Replace `bun.lock` with `pnpm-lock.yaml` or `package-lock.json`
- Everything else same as Option 2

**Pros:**

- Single runtime stack (no hybrid complexity)
- npm/pnpm are battle-tested at scale

**Cons:**

- Slower package installation (Bun is significantly faster)
- Lose Bun's workspace resolution quality
- Additional migration effort for no PQC benefit (tooling is irrelevant to PQ)
- Changing package manager mid-project risks lockfile drift

### Option 4: Migrate auth service only

Move only the auth service (PKI, token signing, PKCS#11) to Node.js. All other
services stay on Bun.

**Approach:**

- Auth service runs under `node`, others under `bun`
- Only auth service gets PQ crypto and PKCS#11
- Mixed runtime in Docker compose

**Pros:**

- Minimal blast radius (1 service)
- Auth gets PQ signatures for cert signing
- Other services keep Bun performance

**Cons:**

- Mixed runtime increases operational complexity
- Two sets of Docker base images, two test runners
- Other services still can't do PQ TLS natively
- Doesn't solve the architectural constraint — Envoy is still required for PQ on non-auth services
- "Worst of both worlds" for maintainability

</details>
