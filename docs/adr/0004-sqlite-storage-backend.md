# ADR-0004: SQLite as Unified Storage Backend

**Status:** Accepted
**Date:** 2026-01-26
**Decision Owner(s):** @jtaylor-orbis @jaeyojae @gsantiago-orbis
**Technical Story:** Replace in-memory stores with persistent SQLite storage for all application state

## Context

The catalyst-router codebase currently uses in-memory `Map<K,V>` objects for storing application state. While simple to implement, this approach has significant limitations for production deployments.

### Current State

In-memory stores exist across multiple packages:

| Package                  | Store                         | Data Structure                | Data Stored                                              |
| ------------------------ | ----------------------------- | ----------------------------- | -------------------------------------------------------- |
| `@catalyst/auth`         | `InMemoryUserStore`           | `Map<string, User>`           | User accounts                                            |
| `@catalyst/auth`         | `InMemoryServiceAccountStore` | `Map<string, ServiceAccount>` | Service accounts                                         |
| `@catalyst/auth`         | `InMemoryBootstrapStore`      | Plain object                  | Bootstrap state                                          |
| `@catalyst/auth`         | `InMemoryRevocationStore`     | `Map<string, number>`         | Revoked JTIs                                             |
| `@catalyst/orchestrator` | `RouteTable`                  | Multiple Maps                 | Routes, peers, metrics                                   |
| `@catalyst/orchestrator` | `ConnectionPool`              | `Map<string, RpcStub>`        | RPC connection cache                                     |
| `@catalyst/node`         | BGP routing types             | Object indices                | Service routes (type definitions only — not implemented) |

**Problems with current approach:**

1. **Data loss on restart** — All state is lost when the process terminates
2. **No durability** — No protection against crashes
3. **No atomic operations** — Race conditions possible on concurrent updates
4. **Memory pressure** — Large datasets consume heap memory
5. **No queryability** — Cannot run ad-hoc queries against stored data

### Scope Exclusions

This ADR does **NOT** apply to:

- **Logs** — Stored in InfluxDB per [[0003-observability-backends|ADR-0003]]
- **Metrics** — Stored in Prometheus per [[0003-observability-backends|ADR-0003]]
- **Traces** — Stored in Jaeger per [[0003-observability-backends|ADR-0003]]
- **Ephemeral caches** — Connection pools, RPC stubs (runtime-only, not persisted)
- **Cryptographic keys** — Already handled by `FileSystemKeyManager`

> **Note:** `InMemoryRevocationStore` is NOT ephemeral — token revocations must survive restarts for security. This store will be migrated to SQLite.

### Requirements

| Requirement                   | Priority | Notes                          |
| ----------------------------- | -------- | ------------------------------ |
| Data persists across restarts | Must     | Core reliability requirement   |
| ACID transactions             | Must     | Prevent partial updates        |
| Zero external dependencies    | Must     | Single-binary deployment goal  |
| Sub-millisecond reads         | Must     | Auth path is latency-sensitive |
| Works with Bun runtime        | Must     | Project runtime                |
| Concurrent read/write support | Should   | Multiple services access state |
| Queryable for debugging       | Should   | Operator productivity          |
| Encryption at rest            | Could    | Future security enhancement    |

## Decision

**Chosen Option: SQLite via `bun:sqlite`**

SQLite provides the best balance of reliability, performance, and operational simplicity for catalyst-router's requirements.

### Rationale

1. **Zero dependencies** — `bun:sqlite` is built into Bun; no npm packages or native compilation required
2. **ACID compliance** — Transactions protect against partial updates and data corruption
3. **Performance** — Sub-millisecond reads; WAL mode enables concurrent reads during writes
4. **Operational simplicity** — Single file database; backup is literally `cp catalyst.db catalyst.db.bak`
5. **Debugging** — SQL queries enable ad-hoc inspection (`SELECT * FROM users WHERE email LIKE '%@example.com'`)
6. **Battle-tested** — SQLite is the most widely deployed database engine, used in browsers, phones, and embedded systems

### Why Not LMDB?

LMDB was seriously considered due to its exceptional read performance and crash-proof design. However, SQLite was chosen because:

1. **No native compilation** — `lmdb-js` requires N-API addon compilation, which can fail on some platforms and complicates CI/CD. Bun's built-in SQLite requires no compilation.
2. **Relational queries** — Our data model includes relationships (users → service_accounts, peers → routes). SQL handles these naturally; LMDB would require manual index maintenance.
3. **Tooling** — Operators can inspect SQLite with standard `sqlite3` CLI. LMDB requires custom tooling or code to inspect data.
4. **Query flexibility** — Ad-hoc debugging queries (`SELECT * FROM users WHERE email LIKE '%'`) are trivial in SQL but require iterator code in LMDB.

If our workload were purely key-value with extreme read performance requirements (e.g., caching millions of session tokens), LMDB would be the better choice.

### Trade-offs Accepted

- **Single-writer limitation** — Only one process can write at a time. WAL mode allows concurrent reads, but writes are serialized. Acceptable for single-node deployment.
- **No built-in replication** — If HA is needed, we'll need application-level replication or external tools (Litestream). Acceptable for v1.
- **Schema migrations required** — Must manage schema changes carefully. Will use simple version table with migration scripts.

### POC Scope Disclaimer

> **Important:** This decision is based on operational simplicity and Bun compatibility, **not** on analysis of actual usage or access patterns. Production workload characteristics (read/write ratios, concurrency levels, data volumes, query patterns) have not been extensively studied.
>
> SQLite is deemed acceptable for POC to unblock development. Once we have real usage data, this decision should be revisited. Potential concerns that may emerge:
>
> - Write contention under high concurrency
> - Query performance at scale (thousands of users/routes)
> - WAL checkpoint impact on read latency
>
> The interface-based architecture (see diagram below) allows swapping storage backends without application code changes.

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Application Layer                            │
│                                                                  │
│   AuthService    OrchestratorService    NodeService              │
│       │                 │                    │                   │
│       └─────────────────┴────────────────────┘                   │
│                         │                                        │
│                         ▼                                        │
│              ┌──────────────────────┐                            │
│              │    Store Interface   │ ← Abstract interface       │
│              │    (UserStore, etc)  │                            │
│              └──────────────────────┘                            │
│                         │                                        │
│           ┌─────────────┴─────────────┐                          │
│           │                           │                          │
│           ▼                           ▼                          │
│   ┌───────────────────┐     ┌───────────────────┐               │
│   │ InMemoryStore     │     │ SqliteStore       │               │
│   │ (testing/dev)     │     │ (production)      │               │
│   └───────────────────┘     └─────────┬─────────┘               │
│                                       │                          │
└───────────────────────────────────────┼──────────────────────────┘
                                        │
                                        ▼
                              ┌───────────────────┐
                              │   catalyst.db     │
                              │   (SQLite file)   │
                              │                   │
                              │ ┌───────────────┐ │
                              │ │ users         │ │
                              │ │ svc_accounts  │ │
                              │ │ revocations   │ │
                              │ │ routes        │ │
                              │ │ peers         │ │
                              │ │ bootstrap     │ │
                              │ └───────────────┘ │
                              └───────────────────┘
```

### Database Configuration

```typescript
import { Database } from 'bun:sqlite'

const db = new Database('catalyst.db', {
  create: true,
  readwrite: true,
})

// Enable WAL mode for concurrent reads
db.exec('PRAGMA journal_mode = WAL')

// Improve write performance (sync on checkpoint, not every write)
db.exec('PRAGMA synchronous = NORMAL')

// Enable foreign keys
db.exec('PRAGMA foreign_keys = ON')

// Set busy timeout for concurrent access (5 seconds)
db.exec('PRAGMA busy_timeout = 5000')
```

### Store Implementation Pattern

Each store will implement the existing interface (defined in `apps/auth/src/stores/types.ts`) but persist to SQLite. The `@catalyst/storage` package provides the database wrapper and schema.

See:

- `packages/storage/src/schema.sql` — Table definitions
- `packages/storage/src/types.ts` — Row types and conversion utilities
- `packages/storage/src/database.ts` — `CatalystDatabase` wrapper

## Consequences

### Positive

- **Data survives restarts** — No more lost state on process restart or crash
- **ACID guarantees** — Atomic transactions prevent partial updates
- **Zero external dependencies** — No database server to install, configure, or monitor
- **Debuggable** — Can query state directly with `sqlite3 catalyst.db`
- **Easy backup** — Copy single file to backup; no export/dump required
- **Consistent latency** — Sub-millisecond reads from WAL; no network hops
- **Memory efficient** — Data on disk, not in heap; SQLite manages its own cache

### Negative

- **Schema migrations** — Must carefully manage schema changes
- **Single-writer bottleneck** — High write contention could become issue (unlikely given workload)
- **No replication** — Single point of failure for data (mitigated by backups)
- **Learning curve** — Developers need SQLite/SQL knowledge

### Neutral

- **Testing flexibility** — Can still use `InMemoryStore` implementations for unit tests
- **File permissions** — Database file needs appropriate filesystem permissions
- **Monitoring** — Need to add database file size and WAL checkpoint metrics

## Implementation

### Phase 1: Infrastructure

1. Create `@catalyst/storage` package with SQLite utilities
2. Add schema migration system (simple version table)
3. Implement `SqliteDatabase` wrapper with connection management

### Phase 2: Auth Package

1. Implement `SqliteUserStore`
2. Implement `SqliteServiceAccountStore`
3. Implement `SqliteBootstrapStore`
4. Implement `SqliteRevocationStore`
5. Add factory function to select store implementation based on config

### Phase 3: Orchestrator Package

1. Implement `SqliteRouteStore`
2. Implement `SqlitePeerStore`
3. Migrate route table state

### Phase 4: Cleanup

1. Mark `InMemory*` stores as test-only
2. Update configuration documentation
3. Add database metrics to telemetry

## Risks and Mitigations

| Risk                                   | Likelihood | Impact | Mitigation                                          |
| -------------------------------------- | ---------- | ------ | --------------------------------------------------- |
| Data corruption from incomplete writes | Low        | High   | WAL mode + PRAGMA synchronous = NORMAL              |
| Database file grows unbounded          | Medium     | Medium | Add VACUUM schedule, size monitoring                |
| Schema migration breaks existing data  | Medium     | High   | Always backup before migration, version table       |
| Concurrent write contention            | Low        | Medium | WAL mode handles most cases; batch writes if needed |
| WAL checkpoint blocks reads            | Low        | Low    | Configure auto-checkpoint size appropriately        |

## Related Decisions

- [[0001-unified-opentelemetry-observability|ADR-0001]] — Observability (traces/metrics/logs go to dedicated backends)
- [[0003-observability-backends|ADR-0003]] — Telemetry backends (Prometheus, Jaeger, InfluxDB)

## References

- [Bun SQLite Documentation](https://bun.sh/docs/api/sqlite)
- [SQLite WAL Mode](https://www.sqlite.org/wal.html)
- [SQLite PRAGMA Statements](https://www.sqlite.org/pragma.html)
- [SQLite in Production](https://www.sqlite.org/whentouse.html)
- [Litestream for SQLite Replication](https://litestream.io/)
- [LMDB Technical Documentation](http://www.lmdb.tech/doc/)
- [lmdb-js on npm](https://www.npmjs.com/package/lmdb)

---

## Appendix: Options Considered

<details>
<summary>Click to expand full options analysis</summary>

### Decision Drivers

- **Operational simplicity** — No separate database server to manage
- **Bun native support** — `bun:sqlite` provides zero-overhead bindings
- **Proven reliability** — SQLite is the most deployed database in the world
- **Single-file storage** — Easy backup, restore, and inspection
- **ACID guarantees** — Transactions prevent data corruption

### Option 1: SQLite (via `bun:sqlite`)

Bun provides native SQLite bindings with synchronous and asynchronous APIs.

**Approach:**

- Use `bun:sqlite` for all persistent application state
- Single database file per node (e.g., `catalyst.db`)
- WAL mode for concurrent access
- Prepared statements for performance

**Pros:**

- Zero external dependencies (bundled with Bun)
- ACID transactions with rollback support
- Sub-millisecond query performance
- Single file — easy ops (backup = copy file)
- SQL queryable for debugging
- Proven at scale (billions of deployments)

**Cons:**

- Single-writer limitation (WAL helps but doesn't eliminate)
- No built-in replication
- Requires schema migrations

### Option 2: LevelDB / RocksDB

Key-value stores with LSM-tree architecture.

**Approach:**

- Use `level` or `rocksdb` npm packages
- Key-value storage model
- Custom serialization layer

**Pros:**

- Excellent write throughput
- Ordered key iteration
- Compression built-in

**Cons:**

- Requires native addon compilation
- No SQL — custom query layer needed
- More complex backup (directory, not single file)
- No transactions across key ranges (RocksDB has, Level doesn't)

### Option 3: Better-SQLite3

Synchronous SQLite bindings for Node.js.

**Approach:**

- Use `better-sqlite3` npm package
- Similar to Option 1 but via npm

**Pros:**

- Well-maintained, popular package
- Synchronous API (simpler code)
- Good documentation

**Cons:**

- Requires native addon compilation
- Bun already provides `bun:sqlite` (redundant dependency)
- Native compilation can fail on some platforms

### Option 4: PostgreSQL / MySQL (External)

Traditional client-server relational database.

**Approach:**

- Run PostgreSQL/MySQL as separate service
- Connect via pg/mysql2 drivers

**Pros:**

- Full SQL capabilities
- Built-in replication
- Connection pooling
- Rich ecosystem

**Cons:**

- External service dependency (violates single-binary goal)
- Operational overhead (backups, updates, monitoring)
- Network latency for every query
- Overkill for single-node state

### Option 5: Hybrid (Keep In-Memory with Persistence Layer)

Persist in-memory state to disk periodically.

**Approach:**

- Keep `Map<K,V>` in memory
- Serialize to JSON/MessagePack on interval
- Load from disk on startup

**Pros:**

- Minimal code changes
- Fastest read performance

**Cons:**

- Data loss between saves
- No transactions
- JSON serialization overhead for large datasets
- No queryability

### Option 6: LMDB (Lightning Memory-Mapped Database)

Ultra-fast memory-mapped key-value store with ACID transactions.

**Approach:**

- Use `lmdb-js` npm package (formerly `lmdb-store`)
- Memory-mapped storage for zero-copy reads
- Key-value model with ordered keys
- Custom serialization (MessagePack or CBOR)

**Pros:**

- Exceptional read performance (memory-mapped, zero-copy)
- ACID compliant with full transaction support
- Multiple concurrent readers with single writer (MVCC)
- Crash-proof — no recovery needed after power failure
- Smaller disk footprint than SQLite for key-value workloads
- Sub-microsecond reads for cached data

**Cons:**

- Requires native addon compilation (`lmdb-js` uses N-API)
- No SQL — requires custom query layer for complex lookups
- Key-value only — no relational queries (joins, aggregations)
- Less tooling for inspection (no `sqlite3` CLI equivalent)
- Memory-mapped approach means DB size affects address space
- Smaller community than SQLite

| Aspect       | Details                              |
| ------------ | ------------------------------------ |
| License      | OpenLDAP Public License (permissive) |
| Bun Support  | Via `lmdb-js` (N-API addon)          |
| Transactions | Full ACID, MVCC                      |
| Concurrency  | Multiple readers, single writer      |

</details>
