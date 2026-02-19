# ADR-0011: Adopt Node.js as JavaScript Runtime

**Status:** Accepted
**Date:** 2026-02-19
**Decision Owner(s):** @jtaylor-orbis

## Context

Catalyst requires post-quantum cryptography (PQC) for all inter-service mTLS communications to meet CNSA 2.0 compliance timelines. Specifically, TLS 1.3 key exchange must use hybrid PQC KEM groups (X25519MLKEM768) as defined in draft-ietf-tls-ecdhe-mlkem and FIPS 203 (ML-KEM).

The project currently runs on Bun, which uses BoringSSL as its TLS library. While BoringSSL contains PQC code (ML-KEM shipped in Chrome 131+), **Bun's API does not expose the `ecdhCurve`/groups option** needed to configure or require PQC KEM groups for TLS connections. This means:

- Bun servers cannot be configured to prefer or require PQC key exchange
- Bun mTLS clients cannot explicitly select PQC groups
- There is no timeline from the Bun team for exposing these controls

This is a blocking gap for PQC compliance.

### Current State

- All services run on Bun 1.3.x (BoringSSL-based TLS)
- mTLS is used for all inter-service communication
- PQC key exchange cannot be configured or enforced via Bun's API
- The `Bun.serve()` TLS options do not include `ecdhCurve` or equivalent group selection

### Requirements

| Requirement                                    | Priority | Notes                                                               |
| ---------------------------------------------- | -------- | ------------------------------------------------------------------- |
| PQC KEM key exchange (X25519MLKEM768) for mTLS | Must     | CNSA 2.0: SHOULD prefer now, MUST by 2027                           |
| Configurable TLS 1.3 group preference          | Must     | Server and client must be able to require PQC groups                |
| Native PQC support (no experimental providers) | Must     | oqs-provider is prototype quality; production needs native support  |
| LTS release with long-term security updates    | Must     | Infrastructure runtime must be on a supported release               |
| ESM module support                             | Must     | Project uses ESM throughout                                         |
| Hono framework compatibility                   | Must     | All services use Hono; must have a Node.js adapter                  |
| Workspace monorepo support                     | Should   | Current Bun workspace + catalog protocol must be replaceable        |
| TypeScript execution or bundling               | Should   | Current Bun runs .ts directly; Node.js needs a build step or loader |

## Decision

**Chosen Option: Node.js 22 LTS (22.20.0+)**

We will migrate the catalyst runtime from Bun to Node.js 22 LTS, minimum version 22.20.0, which bundles OpenSSL 3.5.2 with native, built-in PQC support.

### Rationale

1. **PQC TLS is native and default** — OpenSSL 3.5.2 makes X25519MLKEM768 the default keyshare in TLS 1.3 ClientHello. No extra providers, configuration, or compilation needed. PQC key exchange works out of the box.

2. **Full TLS group control** — Node.js `tls.createServer()` and `tls.connect()` expose the `ecdhCurve` option, which accepts PQC group names:

   ```ts
   tls.createServer({
     ecdhCurve: 'X25519MLKEM768:X25519:P-256',
     requestCert: true,
     rejectUnauthorized: true,
     minVersion: 'TLSv1.3',
   })
   ```

3. **LTS with long-term support** — Node.js 22 is an Active LTS release with security updates through April 2027, aligning with the CNSA 2.0 compliance deadline.

4. **Hono adapter already in use** — `@hono/node-server` (v1.19.7) is already in the workspace catalog and used by `apps/node`. The migration path is proven within this project.

5. **Ecosystem maturity** — OpenTelemetry, better-sqlite3, and all critical dependencies target Node.js as their primary runtime. The Bun compatibility caveats documented in ADR-0001 and ADR-0002 become non-issues.

### Trade-offs Accepted

- **No direct TypeScript execution** — Bun runs `.ts` files directly; Node.js requires a build step (esbuild) or loader (tsx). We accept this because production builds should be bundled anyway, and esbuild is fast.
- **No single-binary compilation** — Bun's `bun build --compile` produces self-contained binaries (used for RPi). Node.js `--experimental-sea` is not production-ready. RPi binary compilation is deferred to a separate workstream.
- **Native addon compilation** — `better-sqlite3` requires build tools in Docker (python3, make, g++). Bun's `bun:sqlite` was zero-dependency. We accept this because the Docker multi-stage build pattern handles it cleanly.
- **Package manager migration** — Bun's built-in package manager must be replaced. pnpm is the only Node.js-compatible option that supports the workspace catalog protocol already in use (see ADR-0014).

## Consequences

### Positive

- **PQC mTLS enabled** — All inter-service mTLS connections can use X25519MLKEM768 hybrid key exchange, meeting CNSA 2.0 requirements
- **OTEL first-class support** — OpenTelemetry Node SDK is the primary target; removes the "not officially supported on Bun" caveat from ADR-0001
- **Larger ecosystem** — All npm packages target Node.js; no more "works on Bun?" compatibility questions
- **Stable, predictable releases** — Node.js LTS has a well-defined release and EOL schedule
- **OpenSSL 3.5 crypto APIs** — Future access to `crypto.encapsulate()`/`crypto.decapsulate()` (Node.js 24.7+) and WebCrypto ML-KEM support

### Negative

- **Migration effort** — Every app, package, Dockerfile, and CI workflow must be updated (see Implementation section)
- **Build step required** — TypeScript must be compiled or bundled before execution; adds build complexity
- **Startup time** — Node.js cold start is slower than Bun for unbundled TypeScript (mitigated by esbuild bundling)
- **RPi binary compilation deferred** — No production-ready single-binary solution for Node.js ESM

### Neutral

- **Performance** — HTTP throughput is comparable between Node.js and Bun for the project's workload (mTLS overhead dominates, not HTTP parsing)
- **WebSocket support** — `@hono/node-server` provides `createNodeWebSocket` as a drop-in replacement for Bun's WebSocket helpers

## Implementation

### Migration Phases

```
Phase A — Foundation (1 PR)
  ├── packages/service: Bun.serve() → @hono/node-server serve()
  ├── packages/service: WebSocket via createNodeWebSocket
  ├── packages/authorization: bun:sqlite → better-sqlite3
  └── Root: bun.lock → pnpm-lock.yaml, pnpm-workspace.yaml

Phase B — App Entrypoints (1 PR)
  ├── apps/auth: remove Bun.main guard, hono/bun → @hono/node-server
  ├── apps/gateway: same
  ├── apps/orchestrator: same
  └── apps/envoy: same

Phase C — Tests (1 PR)
  ├── All Bun.serve() in tests → @hono/node-server
  ├── All Bun.spawn()/spawnSync() → child_process
  └── Bun.sleep() → setTimeout promise wrapper

Phase D — Docker & CI (1 PR)
  ├── Dockerfiles: oven/bun:1.3.6-alpine → node:22-alpine
  ├── Add esbuild build scripts per app
  ├── OpenSSL version assertion in Docker build
  └── CI: bun → pnpm commands

Phase E — Cleanup (1 PR)
  ├── Remove @types/bun from all packages
  ├── Remove Bun-specific scripts (compile:node:exec)
  └── Final ADR updates
```

### Docker Base Image Verification

The Dockerfile must verify OpenSSL 3.5.2+ is present for PQC:

```dockerfile
RUN node -e "const v = process.versions.openssl.split('.').map(Number); \
  if(v[0]<3||v[1]<5) throw new Error('OpenSSL 3.5+ required, got '+process.versions.openssl)"
```

### TLS Configuration Pattern

```ts
// PQC-first group preference for all mTLS connections
const PQC_GROUPS = 'X25519MLKEM768:X25519:P-256'

tls.createServer({
  key: fs.readFileSync('server.key'),
  cert: fs.readFileSync('server.crt'),
  ca: fs.readFileSync('ca.crt'),
  requestCert: true,
  rejectUnauthorized: true,
  ecdhCurve: PQC_GROUPS,
  minVersion: 'TLSv1.3',
})
```

## Downstream ADR Impact

This decision cascades into several existing and new ADRs:

### Existing ADRs Affected

| ADR                                                   | Title                               | Action                                                   | Reason                                                                    |
| ----------------------------------------------------- | ----------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------- |
| [0004](./0004-sqlite-storage-backend.md)              | SQLite as Unified Storage Backend   | **Superseded** by [ADR-0012](./0012-sqlite-on-nodejs.md) | `bun:sqlite` is unavailable on Node.js; entire rationale was Bun-specific |
| [0002](./0002-logging-library-selection.md)           | Logging Library Selection           | **Amended**                                              | "Bun compatibility: Must" changed to "Node.js compatibility: Must"        |
| [0010](./0010-catalyst-service-base-class.md)         | Catalyst Service Base Class         | **Amended**                                              | `Bun.serve()` binding changed to `@hono/node-server`                      |
| [0001](./0001-unified-opentelemetry-observability.md) | Unified OpenTelemetry Observability | **Amended**                                              | Bun compatibility caveat removed; OTEL Node SDK is now first-class        |

### New Companion ADRs

| ADR                                         | Title                             | Status   | Relationship                                 |
| ------------------------------------------- | --------------------------------- | -------- | -------------------------------------------- |
| [0012](./0012-sqlite-on-nodejs.md)          | SQLite Storage Backend on Node.js | Accepted | Supersedes ADR-0004; adopts `better-sqlite3` |
| [0013](./0013-test-runner-selection.md)     | Test Runner Selection (Vitest)    | Accepted | Replaces `bun test` with Vitest              |
| [0014](./0014-package-manager-selection.md) | Package Manager Selection (pnpm)  | Accepted | Replaces Bun's package manager with pnpm     |

## Risks and Mitigations

| Risk                                                         | Likelihood | Impact | Mitigation                                                                      |
| ------------------------------------------------------------ | ---------- | ------ | ------------------------------------------------------------------------------- |
| `node:22-alpine` ships older OpenSSL                         | Low        | High   | Assert OpenSSL version in Dockerfile; fall back to `node:22` (Debian) if needed |
| capnweb RPC incompatible with `@hono/node-server` WebSockets | Medium     | High   | Test minimal RPC roundtrip early in Phase A before committing                   |
| `better-sqlite3` native build fails in Docker                | Low        | Medium | Standard Alpine build tools pattern (`apk add python3 make g++`)                |
| esbuild misses dynamic imports (OTEL instrumentation)        | Medium     | Medium | Use `--packages=external`; ship `node_modules` alongside bundle                 |
| Migration introduces regressions                             | Medium     | Medium | Phased approach with CI green at each phase; full test suite before merge       |
| RPi binary compilation blocked                               | High       | Low    | Separate workstream; not on critical path for PQC compliance                    |

## Related Decisions

- [ADR-0001](./0001-unified-opentelemetry-observability.md) — Amended: Bun compatibility caveat removed
- [ADR-0002](./0002-logging-library-selection.md) — Amended: runtime requirement updated
- [ADR-0004](./0004-sqlite-storage-backend.md) — Superseded by ADR-0012
- [ADR-0010](./0010-catalyst-service-base-class.md) — Amended: server binding updated
- [ADR-0012](./0012-sqlite-on-nodejs.md) — SQLite on Node.js (companion)
- [ADR-0013](./0013-test-runner-selection.md) — Test runner selection (companion)
- [ADR-0014](./0014-package-manager-selection.md) — Package manager selection (companion)

## References

- [FIPS 203 — ML-KEM (Module-Lattice Key Encapsulation Mechanism)](https://csrc.nist.gov/pubs/fips/203/final)
- [FIPS 204 — ML-DSA (Module-Lattice Digital Signature Algorithm)](https://csrc.nist.gov/pubs/fips/204/final)
- [draft-ietf-tls-ecdhe-mlkem-04 — Hybrid ECDHE-MLKEM for TLS 1.3](https://datatracker.ietf.org/doc/draft-ietf-tls-ecdhe-mlkem/)
- [CNSA 2.0 Algorithm Guidance](https://media.defense.gov/2022/Sep/07/2003071834/-1/-1/0/CSA_CNSA_2.0_ALGORITHMS_.PDF)
- [OpenSSL 3.5 Release Notes](https://openssl-library.org/news/openssl-3.5-notes/)
- [Node.js 22.20.0 Release](https://nodejs.org/en/blog/release/v22.20.0)
- [@hono/node-server](https://github.com/honojs/node-server)
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)

---

## Appendix: Options Considered

<details>
<summary>Click to expand full options analysis</summary>

### Decision Drivers

- **PQC Compliance** — Must support ML-KEM hybrid key exchange for TLS 1.3 mTLS by CNSA 2.0 deadlines
- **API Control** — Must be able to configure TLS group preferences programmatically
- **Production Readiness** — Runtime must be LTS with security update guarantees
- **Migration Cost** — Prefer the option with the lowest disruption to existing codebase
- **Ecosystem Support** — Critical dependencies (OTEL, SQLite, Hono) must work on the target runtime

### Option 1: Stay on Bun, Wait for PQC API Exposure

Continue using Bun and wait for the Bun team to expose `ecdhCurve`/groups configuration in `Bun.serve()` TLS options.

**Approach:**

- File an issue/PR with the Bun project requesting PQC group configuration
- Continue development on Bun in the meantime
- Migrate only if Bun does not deliver within a defined timeline

**Pros:**

- Zero migration effort
- Bun's developer experience (direct .ts execution, fast startup, built-in tools)
- No build step needed for development or production

**Cons:**

- **No timeline** — Bun has not indicated when or if `ecdhCurve` will be exposed
- **Blocks PQC compliance** — Cannot meet CNSA 2.0 "SHOULD" (2025) or "MUST" (2027) deadlines
- **BoringSSL limitations** — Even if Bun exposes the API, BoringSSL rejects ML-DSA certificates for TLS authentication, limiting future PQC signature migration
- **Dependency on external project** — Critical compliance path depends on a third-party roadmap we don't control

### Option 2: Node.js 22 LTS (22.20.0+) — CHOSEN

Migrate to Node.js 22 LTS with OpenSSL 3.5.2 for native PQC support.

**Approach:**

- Replace Bun runtime with Node.js 22 LTS across all services
- Use `@hono/node-server` for HTTP binding (already in workspace)
- Use pnpm for package management (catalog protocol support)
- Use Vitest for testing (already partially adopted)
- Use esbuild for production bundling in Docker

**Pros:**

- Native PQC TLS support via OpenSSL 3.5.2 — zero configuration needed for default X25519MLKEM768
- Full `ecdhCurve` API for explicit group control in mTLS
- LTS with security updates through April 2027
- OTEL Node SDK is the primary supported target
- Largest npm ecosystem compatibility
- Proven migration path — `@hono/node-server` already used by `apps/node`

**Cons:**

- Significant migration effort (5 phases, all apps/packages/Docker/CI)
- Requires build step (esbuild or tsx) for TypeScript
- No single-binary compilation (RPi workstream deferred)
- Native addon compilation for `better-sqlite3` in Docker

### Option 3: Node.js 24 Current

Migrate to Node.js 24.x for the latest PQC crypto APIs.

**Approach:**

- Same as Option 2, but target Node.js 24.x instead of 22 LTS
- Gains access to `crypto.encapsulate()`/`crypto.decapsulate()` (24.7.0+)
- WebCrypto ML-KEM support

**Pros:**

- All benefits of Option 2
- Additional PQC crypto APIs beyond TLS (useful for application-layer crypto)
- WebCrypto PQC support for future certificate operations

**Cons:**

- **Not LTS** — Current release line; no long-term support guarantee
- Odd-numbered releases do not become LTS (Node.js 25 will not be LTS; Node.js 26 will)
- Higher risk of breaking changes between minor versions
- Node.js 22 LTS already provides all TLS-level PQC needed for mTLS

### Option 4: Deno

Migrate to Deno, which also uses OpenSSL-compatible TLS.

**Approach:**

- Replace Bun with Deno runtime
- Use Deno's Node.js compatibility layer for npm packages
- Leverage Deno's built-in TypeScript support

**Pros:**

- Built-in TypeScript execution (like Bun)
- Security-focused design (permissions model)
- OpenSSL-based TLS (PQC potential, version-dependent)

**Cons:**

- **Unverified PQC support** — Deno's TLS API exposure for PQC groups is not documented
- **Ecosystem friction** — npm compatibility layer adds complexity; not all packages work
- **Smaller community** — Fewer production deployments, less battle-tested
- **Higher migration risk** — Moving to Deno is a larger ecosystem shift than Node.js
- **Hono adapter less mature** — `@hono/deno-server` exists but is less proven than `@hono/node-server`

</details>
