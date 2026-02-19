# ADR-0012: SQLite Storage Backend on Node.js

**Status:** Accepted
**Date:** 2026-02-18
**Decision Owner(s):** Engineering Team

## Context

[ADR-0004](./0004-sqlite-storage-backend.md) established SQLite as the unified storage backend for catalyst-router, with the specific binding chosen being `bun:sqlite` — a zero-dependency, natively-compiled SQLite driver built into Bun.

The project is migrating from Bun to Node.js as its JavaScript runtime (ADR-0011). `bun:sqlite` is a Bun-only API and is completely unavailable on Node.js. This makes ADR-0004 unimplementable on the target runtime. A new binding decision is required.

### Current State

Two files in `packages/authorization` import directly from `bun:sqlite`:

| File                                                         | Class                 | Purpose                               |
| ------------------------------------------------------------ | --------------------- | ------------------------------------- |
| `packages/authorization/src/jwt/local/sqlite-store.ts`       | `BunSqliteTokenStore` | JWT token record and revocation store |
| `packages/authorization/src/key-manager/sqlite-key-store.ts` | `BunSqliteKeyStore`   | JWKS key set persistence              |

Both use the `bun:sqlite` `Database` class with synchronous prepared statements. The SQL schema, query patterns, and store interfaces are all sound and carry over unchanged — only the import and minor API surface differences need to be addressed.

### What ADR-0004 Decided (and Why It No Longer Applies)

ADR-0004 chose `bun:sqlite` for one overriding reason: zero external dependencies. The key rationale was:

> "Zero dependencies — `bun:sqlite` is built into Bun; no npm packages or native compilation required"

It explicitly rejected `better-sqlite3` with: "Bun already provides `bun:sqlite` (redundant dependency)." That rejection only made sense while Bun was the runtime. On Node.js, that reasoning inverts entirely.

The architectural goals of ADR-0004 — ACID transactions, sub-millisecond reads, single-file storage, WAL mode, zero external server — remain valid and are unchanged by this decision.

### Node.js SQLite Options

| Binding          | Availability          | Stability                          | Notes                                   |
| ---------------- | --------------------- | ---------------------------------- | --------------------------------------- |
| `better-sqlite3` | npm package           | Production-stable (v9.x, 7+ years) | Synchronous API; N-API native addon     |
| `node:sqlite`    | Built into Node 22.5+ | Experimental (as of Node 22/23)    | Async API; will stabilize in future LTS |

### Requirements

| Requirement                   | Priority | Notes                                                  |
| ----------------------------- | -------- | ------------------------------------------------------ |
| Data persists across restarts | Must     | Core reliability requirement                           |
| ACID transactions             | Must     | Prevent partial updates                                |
| Works with Node.js runtime    | Must     | Migration target                                       |
| Sub-millisecond reads         | Must     | Auth revocation check is on the hot path               |
| Synchronous API available     | Should   | Avoids async/await complexity in store implementations |
| Zero external server          | Must     | Single-binary deployment goal                          |
| WAL mode support              | Should   | Enables concurrent reads during writes                 |
| Queryable for debugging       | Should   | Operator productivity                                  |

## Decision

**Chosen Option: `better-sqlite3`**

Adopt `better-sqlite3` as the SQLite binding on Node.js, replacing `bun:sqlite`. The migration is largely mechanical: the API surface is nearly identical, and the SQL schemas, query patterns, and store interfaces are unchanged.

### Rationale

1. **Production stability** — `better-sqlite3` has been in production use for 7+ years across the Node.js ecosystem, with well-understood operational characteristics. `node:sqlite` is explicitly marked experimental and not recommended for production workloads.

2. **Synchronous API** — Both `bun:sqlite` and `better-sqlite3` are synchronous. The existing store implementations (`BunSqliteTokenStore`, `BunSqliteKeyStore`) use synchronous calls throughout; the migration requires only import and minor API adjustments, not async refactors.

3. **API near-parity with `bun:sqlite`** — The two libraries share the same core patterns: `new Database(path)`, `db.prepare(sql)`, `stmt.run(params)`, `stmt.get(params)`, `stmt.all(params)`. Parameter binding syntax differs (named `$param` in `bun:sqlite`; positional or named in `better-sqlite3`) but this is a mechanical change.

4. **Native addon compilation is now acceptable** — ADR-0004 rejected `better-sqlite3` solely because `bun:sqlite` made it redundant. On Node.js there is no built-in alternative. The compilation step is well-understood, handled automatically by `npm install` / `pnpm install`, and prebuilt binaries are available for common platforms via `@mapbox/node-pre-gyp`.

5. **WAL mode, ACID, single-file** — All of ADR-0004's storage goals are equally achievable with `better-sqlite3`. Pragma configuration (`WAL`, `synchronous = NORMAL`, `foreign_keys = ON`, `busy_timeout = 5000`) is identical.

### API Differences to Address

The migration from `bun:sqlite` to `better-sqlite3` requires these code changes:

| Pattern              | `bun:sqlite`                            | `better-sqlite3`                        |
| -------------------- | --------------------------------------- | --------------------------------------- |
| Import               | `import { Database } from 'bun:sqlite'` | `import Database from 'better-sqlite3'` |
| Instantiation        | `new Database(path)`                    | `new Database(path)` (identical)        |
| Run without result   | `db.run(sql, params)`                   | `db.prepare(sql).run(params)`           |
| Prepared run         | `stmt.run(params)`                      | `stmt.run(params)` (identical)          |
| Single row fetch     | `stmt.get(params)`                      | `stmt.get(params)` (identical)          |
| All rows fetch       | `stmt.all(params)`                      | `stmt.all(params)` (identical)          |
| Query shorthand      | `db.query(sql).all(params)`             | `db.prepare(sql).all(params)`           |
| Named param prefix   | `$paramName`                            | `@paramName` (or positional `?`)        |
| Exec multi-statement | `db.exec(sql)`                          | `db.exec(sql)` (identical)              |

The named parameter prefix difference (`$` → `@`) is the most pervasive change in the existing stores and must be applied consistently.

### Trade-offs Accepted

- **Native addon compilation required** — `better-sqlite3` uses an N-API native addon. This adds a compilation step to Docker builds and CI. Alpine-based Docker images need build tools installed in the deps stage (`apk add python3 make g++`). This is a known, well-documented operational cost. Prebuilt binaries via `node-pre-gyp` reduce this for common platforms (linux/amd64, linux/arm64, darwin, win32).
- **Not a true zero-dependency path** — Unlike `bun:sqlite`, this is an external npm package. We accept this because there is no built-in alternative with production stability on Node.js.
- **`node:sqlite` deferred** — We are choosing not to adopt `node:sqlite` now. When it graduates from experimental status (expected in a future Node.js LTS), this decision should be revisited to eliminate the native addon dependency.

## Consequences

### Positive

- All of ADR-0004's storage goals are preserved: ACID transactions, WAL mode, sub-millisecond reads, single-file backup, operator queryability with `sqlite3` CLI.
- Migration is mechanical — SQL schemas, store interfaces, and query logic are unchanged.
- Synchronous API is retained — no async refactoring of store implementations required.
- `better-sqlite3` is widely used in the Node.js ecosystem with large community and documentation.

### Negative

- Native addon compilation adds complexity to Docker builds: Alpine images need `python3 make g++` in the deps stage.
- Additional npm dependency vs. the previous zero-dependency `bun:sqlite` approach.
- Named parameter prefix change (`$param` → `@param`) must be applied across all prepared statements in affected stores.

### Neutral

- Class names (`BunSqliteTokenStore`, `BunSqliteKeyStore`) should be renamed to remove the Bun prefix (e.g., `SqliteTokenStore`, `SqliteKeyStore`). This is a cosmetic change with no behavioral impact.
- The SQLite database file format, schema, and pragma configuration are identical between `bun:sqlite` and `better-sqlite3`. Existing `catalyst.db` files are fully compatible with no migration needed.
- WAL checkpoint behavior and concurrency characteristics are unchanged.

## Implementation

### Phase 1: Package change

Add `better-sqlite3` and its TypeScript types to `packages/authorization`:

```
pnpm add better-sqlite3
pnpm add -D @types/better-sqlite3
```

### Phase 2: Store migration

Update `packages/authorization/src/jwt/local/sqlite-store.ts`:

```typescript
// Before
import { Database } from 'bun:sqlite'

// After
import Database from 'better-sqlite3'
```

Update named parameter prefixes throughout both store files (`$param` → `@param`):

```typescript
// Before (bun:sqlite)
stmt.run({ $jti: record.jti, $expires_at: record.expiry })

// After (better-sqlite3)
stmt.run({ jti: record.jti, expires_at: record.expiry })
// better-sqlite3 accepts plain object keys matching :name / @name / $name — all styles work
// Recommend switching to plain keys without prefix for clarity
```

Replace `db.run()` shorthand with `db.prepare().run()`:

```typescript
// Before (bun:sqlite — db.run is a shorthand)
this.db.run('UPDATE token SET is_revoked = 1 WHERE jti = ?', [jti])

// After (better-sqlite3 — must use prepare)
this.db.prepare('UPDATE token SET is_revoked = 1 WHERE jti = ?').run(jti)
```

Replace `db.query().all()` with `db.prepare().all()`:

```typescript
// Before
const rows = this.db.query('SELECT jti FROM token WHERE ...').all(now)

// After
const rows = this.db.prepare('SELECT jti FROM token WHERE ...').all(now)
```

### Phase 3: Docker build tooling

Add build tools to the `deps` stage of Dockerfiles for services that depend on `packages/authorization` (auth, orchestrator):

```dockerfile
FROM node:22-alpine AS deps

# Required for better-sqlite3 native addon compilation
RUN apk add --no-cache python3 make g++

WORKDIR /app
# ... rest of install step
```

The runtime stage does not need build tools — only the compiled `.node` addon binary, which is copied with `node_modules`.

### Phase 4: Rename store classes

Rename `BunSqliteTokenStore` → `SqliteTokenStore` and `BunSqliteKeyStore` → `SqliteKeyStore` to remove the Bun-specific prefix.

## Risks and Mitigations

| Risk                                                  | Likelihood | Impact | Mitigation                                                                                        |
| ----------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------- |
| Native addon fails to compile on Alpine               | Medium     | High   | Add `python3 make g++` to all deps-stage Dockerfiles; test CI on Alpine target                    |
| Prebuilt binary mismatch on ARM builds                | Medium     | Medium | Force compile from source in Dockerfile (`--build-from-source` flag or omit prebuilt download)    |
| Named param prefix bugs missed in migration           | Medium     | Medium | Type-safe store tests exercise all query paths; add regression tests for revocation and key fetch |
| `node:sqlite` ships stable before Node.js LTS upgrade | Low        | Low    | Track Node.js release notes; revisit this ADR at next LTS adoption                                |

## Related Decisions

- [ADR-0004](./0004-sqlite-storage-backend.md) — Superseded by this ADR; established SQLite as the storage layer using `bun:sqlite`
- [ADR-0009](./0009-relational-database-style-guide.md) — SQL naming conventions remain in effect; schema is unchanged
- ADR-0011 — Node.js runtime adoption; the direct motivation for this decision

## References

- [better-sqlite3 documentation](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md)
- [better-sqlite3 on npm](https://www.npmjs.com/package/better-sqlite3)
- [node:sqlite documentation (experimental)](https://nodejs.org/api/sqlite.html)
- [bun:sqlite documentation](https://bun.sh/docs/api/sqlite)
- [ADR-0004](./0004-sqlite-storage-backend.md) — Original SQLite binding decision

---

## Appendix: Options Considered

<details>
<summary>Click to expand full options analysis</summary>

### Decision Drivers

- **Node.js compatibility** — Must work on Node.js LTS; `bun:sqlite` is not available
- **API continuity** — Prefer synchronous API to avoid rewriting store implementations
- **Production stability** — Must be suitable for production use without caveats
- **Operational simplicity** — Maintain single-file database, WAL mode, zero server dependency
- **Build complexity** — Minimize Docker and CI overhead

### Option 1: `better-sqlite3` (chosen)

The most widely used synchronous SQLite binding for Node.js, using an N-API native addon.

**Approach:**

- Replace `import { Database } from 'bun:sqlite'` with `import Database from 'better-sqlite3'`
- Update named parameter syntax and `db.run` / `db.query` shorthands
- Add `python3 make g++` to Alpine Docker deps stages

**Pros:**

- Synchronous API — no async refactor needed in stores
- Near-identical API to `bun:sqlite` — mechanical migration
- 7+ years of production use in the Node.js ecosystem
- Prebuilt binaries available for common platforms
- Well-documented, actively maintained, stable semver
- Full WAL mode, PRAGMA support, prepared statements

**Cons:**

- N-API native addon requires build tools in Docker
- External npm dependency (no longer zero-dependency)
- Prebuilt binary may not cover all CI/CD platform combinations

### Option 2: `node:sqlite` (built-in, experimental)

Node.js 22.5+ ships an experimental `node:sqlite` module as a built-in.

**Approach:**

- Replace `import { Database } from 'bun:sqlite'` with `import { DatabaseSync } from 'node:sqlite'`
- `DatabaseSync` provides a synchronous API similar to `bun:sqlite`
- No npm dependency, no native addon compilation

**Pros:**

- Zero external dependencies — built into Node.js
- No native addon compilation in Docker
- API uses `DatabaseSync` which is synchronous (matching existing code structure)
- Will eventually be the "right" answer once stable

**Cons:**

- Explicitly marked **experimental** as of Node.js 22/23 — not recommended for production
- API may have breaking changes before stabilization
- Requires Node.js 22.5+ minimum (cuts off Node.js 20 LTS)
- Smaller community surface for issue tracking and support
- Risk: if API changes before stabilization, we absorb another migration

**Verdict:** Deferred. The right choice once stable, but not appropriate for production adoption today.

### Option 3: `sql.js` (WASM-based SQLite)

A WASM port of SQLite that requires no native compilation.

**Approach:**

- Use `sql.js` npm package
- Runs SQLite compiled to WebAssembly — no N-API, no build tools

**Pros:**

- No native addon — works everywhere without build tools
- Pure JavaScript/WASM — Docker Alpine images need no changes
- Portable across platforms

**Cons:**

- In-memory only by default — persisting to disk requires manual serialization/deserialization
- No WAL mode support (WASM SQLite does not expose VFS layer)
- Significantly higher memory overhead than native bindings
- Slower than native for write-heavy workloads
- Poor fit for the persistent, file-based storage model established in ADR-0004

**Verdict:** Rejected. The disk-persistence and WAL mode requirements make this option unworkable.

### Option 4: Abandon SQLite, use a different storage backend

Instead of replacing the SQLite binding, migrate to a different storage technology (e.g., LevelDB, LMDB, or embedded key-value store).

**Approach:**

- Rewrite `TokenStore` and `IKeyStore` implementations against a new backend
- Replace SQL schema with key-value or document model

**Pros:**

- Could choose a truly zero-dependency path (e.g., LMDB with prebuilt binaries)
- Opportunity to revisit the data model

**Cons:**

- High migration cost — SQL schema, query logic, and store implementations all change
- ADR-0004's relational querying rationale (token filtering by fingerprint, SAN, expiry) is well-suited to SQL; key-value stores require custom index management
- Operator tooling (`sqlite3 catalyst.db`) is lost
- Premature: the storage architecture is sound; only the binding needs to change

**Verdict:** Rejected. The storage architecture is correct; this change is scoped to the binding layer only.

</details>
