# Catalyst Node Constitution

**Version**: 1.0.0 | **Ratified**: 2026-02-05 | **Last Amended**: 2026-02-05

> This constitution defines the immutable architectural principles for the Catalyst Node project.
> All specifications, implementation plans, and code changes MUST comply with these principles.
> Violations are CRITICAL findings that block merge. No exceptions.

---

## Quick Reference

| ID   | Principle                     | Category    | Key Rule                                                                |
| ---- | ----------------------------- | ----------- | ----------------------------------------------------------------------- |
| I    | Decentralized Service Routing | Structural  | BGP-inspired L4-7 peering, no centralized routing                       |
| II   | Core Pod Architecture         | Structural  | Orchestrator + sidecars, Capnweb RPC between components                 |
| III  | V2 Dispatch Pattern           | Structural  | `dispatch()` → `handleAction()` → `handleNotify()`, not V1 plugins      |
| IV   | Dependency Inversion          | Structural  | Accept interfaces, not concrete implementations                         |
| V    | Package Boundary Integrity    | Structural  | Inward dependencies, no cross-package internal imports                  |
| VI   | ESM Module Conventions        | Structural  | `.js` extensions, `type` imports, kebab-case files                      |
| VII  | Schema-First Validation       | Quality     | Zod schemas on all external boundaries, `z.infer<>` for types           |
| VIII | Discriminated Union Results   | Quality     | `{ success, data/error }` for fallible operations                       |
| IX   | Strict Typing                 | Quality     | No `any`, no `@ts-ignore`, explicit return types on public APIs         |
| X    | Persistent State in SQLite    | Quality     | SQLite via `bun:sqlite`, WAL mode, no in-memory Maps for durable state  |
| XI   | Database Naming Conventions   | Quality     | snake_case, singular tables, `_at` suffix for timestamps                |
| XII  | Test-Driven Development       | Quality     | Red → green → refactor; unit + E2E coverage required                    |
| XIII | Small PRs & Graphite          | Quality     | Under 600 lines, `gt` commands only, stacked PRs                        |
| XIV  | Conventional Commits          | Quality     | commitlint format: `type(scope): description`, lowercase, max 100 chars |
| XV   | Security-First                | Operational | mTLS, cert-bound JWTs, timing-safe comparisons, policy engine           |
| XVI  | Unified Observability (OTEL)  | Operational | LogTape + OTEL Collector, no `console.log`, Apache 2.0/MIT backends     |
| XVII | Distributed Systems Awareness | Operational | 30s clock tolerance, idempotent ops, graceful degradation               |

---

## Structural Principles

### I. Decentralized Service Routing

**Statement**: Catalyst Node operates as a decentralized service mesh using a BGP-inspired protocol for Layers 4-7. No centralized coordinator may be introduced that creates a single point of failure for routing decisions.

| DO                                                          | DON'T                                                  |
| ----------------------------------------------------------- | ------------------------------------------------------ |
| Use peer-to-peer route exchange via BGP UPDATE messages     | Introduce a central registry all nodes must contact    |
| Design for eventual consistency with convergence guarantees | Create synchronous cross-node dependencies for routing |

**Rationale**: The core value proposition of Catalyst is trustless, decentralized service peering. Centralizing routing defeats the architecture.

**Compliance Check**: Does this change introduce a centralized dependency for route resolution or service discovery?

---

### II. Core Pod Architecture

**Statement**: The system runs as a cohesive set of components ("The Core Pod"): Orchestrator, Envoy Proxy (data plane), GraphQL Gateway (sidecar), Auth Service (sidecar), and OTEL Collector (sidecar). New components must fit within this topology or justify their addition.

| DO                                                   | DON'T                                                     |
| ---------------------------------------------------- | --------------------------------------------------------- |
| Add functionality as extensions to existing sidecars | Add new standalone services that bypass the Orchestrator  |
| Use Capnweb RPC for inter-component communication    | Create direct communication paths that skip the RPC layer |

**Rationale**: The pod model ensures operational simplicity, co-located components, and a well-defined communication topology.

**Compliance Check**: Does this change respect the pod boundary? Does inter-component communication use Capnweb RPC?

---

### III. V2 Dispatch Pattern

**Statement**: The two-phase dispatch pattern in `CatalystNodeBus` is canonical. V1 plugin interfaces are deprecated. All control plane actions flow through `dispatch()` → `handleAction()` (pure state transitions) → `handleNotify()` (side effects).

| DO                                                  | DON'T                                               |
| --------------------------------------------------- | --------------------------------------------------- |
| Add state handlers in `handleAction()` switch cases | Create files in `src/plugins/implementations/`      |
| Add side effects in `handleNotify()`                | Use V1 `PluginPipeline` or `StatePlugin` interfaces |
| Flow all actions through `dispatch()`               | Bypass dispatch for "quick fixes"                   |
| Define new actions in `action-types.ts`             | Mutate global state outside the dispatch pipeline   |

**Rationale**: V2's explicit two-phase state transitions (pure computation, then side effects) are testable and debuggable. V1's implicit plugin chain is not. The `handleAction()` switch ensures all state mutations are visible in one place.

**Compliance Check**: No new files in `src/plugins/`; all actions use `dispatch()`; state mutations only in `handleAction()`.

---

### IV. Dependency Inversion

**Statement**: Core packages accept interfaces, not concrete implementations. Dependencies must be injectable and mockable. Constructors accept optional interface parameters with sensible defaults.

| DO                                           | DON'T                                             |
| -------------------------------------------- | ------------------------------------------------- |
| `constructor(config, authStore?: AuthStore)` | `this.store = new FileAuthStore()` in constructor |
| Define interface + multiple implementations  | Import database clients in orchestrator core      |
| Optional dependencies with sensible defaults | Required concrete dependencies                    |
| In-memory implementations for tests          | Hard-wiring production dependencies               |

**Rationale**: Enables testing without infrastructure, swapping backends, and running with features disabled. The auth package already demonstrates this with `InMemoryStore` / `SqliteStore` behind `UserStore` interfaces.

**Compliance Check**: Constructors accept optional interface params; no `new ConcreteService()` hardcoded in core logic.

---

### V. Package Boundary Integrity

**Statement**: Each package (`@catalyst/auth`, `@catalyst/gateway`, `@catalyst/orchestrator`, etc.) has a clear domain boundary. Dependencies flow inward (packages depend on shared packages like `@catalyst/config`, not on each other's internals).

| DO                                                      | DON'T                                         |
| ------------------------------------------------------- | --------------------------------------------- |
| Use public exports from package `index.ts` barrel files | Import from `@catalyst/auth/src/internal/...` |
| Share types and schemas via `@catalyst/config`          | Create circular dependencies between packages |

**Rationale**: Clean boundaries enable independent testing, deployment, and evolution of components.

**Compliance Check**: Does this change import from another package's internal paths? Does it create a circular dependency?

---

### VI. ESM Module Conventions

**Statement**: All code uses ESM (`"type": "module"`) with `.js` extensions in imports, `type` keyword for type-only imports, and kebab-case file naming.

| DO                                            | DON'T                                                     |
| --------------------------------------------- | --------------------------------------------------------- |
| `import { signToken } from './jwt.js'`        | `import { signToken } from './jwt'` (missing extension)   |
| `import type { SignOptions } from './jwt.js'` | `import { SignOptions } from './jwt.js'` (missing `type`) |

**Rationale**: ESM compliance ensures compatibility with Bun and Node.js runtimes and prevents build-time ambiguity.

**Compliance Check**: Do all imports use `.js` extensions? Are type-only imports marked with `type`?

---

## Quality Principles

### VII. Schema-First Validation

**Statement**: All external boundaries (API inputs, actions, configs, RPC messages, environment variables) MUST be validated with Zod schemas at runtime. Schemas are the source of truth for TypeScript types via `z.infer<>`.

| DO                                                                           | DON'T                                                          |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `const FooSchema = z.object({...})` + `type Foo = z.infer<typeof FooSchema>` | `as` type assertions on external data                          |
| `z.discriminatedUnion('action', [...])` for actions                          | `action: any` or `Record<string, unknown>` for complex objects |
| `ConfigSchema.parse(config)` at startup                                      | Trust incoming data without validation                         |
| `safeParse()` at system boundaries                                           | Define interfaces manually when Zod could generate them        |

**Rationale**: TypeScript types vanish at runtime. In a distributed system, Zod catches malformed inputs that would crash later or cross trust boundaries.

**Compliance Check**: Is external data validated with Zod? Are types derived from schemas? All Actions have Zod schemas?

---

### VIII. Discriminated Union Results

**Statement**: All operations that can fail MUST return discriminated union results: `{ success: true, data: T } | { success: false, error: string }`. Exceptions are reserved for truly exceptional conditions.

| DO                                                            | DON'T                                                              |
| ------------------------------------------------------------- | ------------------------------------------------------------------ |
| `return { success: true, data: token }`                       | Throw errors for expected failures (invalid input, expired tokens) |
| `z.discriminatedUnion('success', [...])` for response schemas | Return `null` or `undefined` to indicate failure                   |

**Rationale**: Discriminated unions make failure explicit in the type system, prevent unhandled exceptions in distributed RPC flows, and enable pattern matching.

**Compliance Check**: Do new functions return discriminated unions for fallible operations?

---

### IX. Strict Typing

**Statement**: TypeScript strict mode enabled. No `any`. No `@ts-ignore` without a linked issue. Explicit return types on exported functions and class methods. Type inference is permitted for internal helpers and callbacks.

| DO                                              | DON'T                              |
| ----------------------------------------------- | ---------------------------------- |
| `function foo(x: Input): Output` on public APIs | Implicit `any` from missing types  |
| `unknown` + type narrowing                      | `any` to silence the compiler      |
| `@ts-ignore // TODO: <description>`             | `@ts-ignore` without justification |

**Rationale**: `any` defeats TypeScript. Strict typing catches bugs at compile time, especially critical in a distributed system where runtime debugging across nodes is expensive.

**Compliance Check**: `tsconfig.json` has `strict: true`; no `any` in new code; `@ts-ignore` has issue link.

---

### X. Persistent State in SQLite

**Statement**: All application state that must survive restarts MUST be stored in SQLite via `bun:sqlite`. In-memory `Map<K,V>` stores are only permitted for ephemeral caches (connection pools, RPC stubs) and test doubles. SQLite databases must use WAL mode, foreign keys ON, and busy_timeout 5000.

| DO                                                                           | DON'T                                                        |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `SqliteStore` for production, `InMemoryStore` for tests                      | Store users, tokens, routes in in-memory Maps for production |
| `PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;` | Use external databases (PostgreSQL, Redis)                   |
| Abstract interface with multiple implementations                             | Skip required pragmas on SQLite initialization               |

**Rationale**: ADR-0004 mandates SQLite for zero-dependency persistence with sub-millisecond reads. In-memory stores cause data loss on restart.

**Compliance Check**: Does this change store persistent data in-memory? Does SQLite usage include required pragmas?

**ADR Reference**: [ADR-0004](../docs/adr/0004-sqlite-storage-backend.md)

---

### XI. Database Naming Conventions & UTC Dates

**Statement**: All SQLite schema objects follow the RDBMS Style Guide (ADR-0009): lowercase with underscores, singular table names, descriptive column names, no abbreviations. All dates stored as UTC. ISO 8601 format for API serialization.

| Context               | Convention                   | Example                                     |
| --------------------- | ---------------------------- | ------------------------------------------- |
| Table names           | snake_case, singular         | `service_account`, `token_revocation`       |
| Column names          | snake_case, descriptive      | `display_name`, `created_at`                |
| TypeScript timestamps | camelCase with `At` suffix   | `createdAt`, `expiresAt`, `lastLoginAt`     |
| Database timestamps   | snake_case with `_at` suffix | `created_at`, `expires_at`, `last_login_at` |
| API responses         | camelCase, ISO 8601 UTC      | `"createdAt": "2024-01-15T10:30:00Z"`       |

| DO                                                                    | DON'T                                                   |
| --------------------------------------------------------------------- | ------------------------------------------------------- |
| `CREATE TABLE service_account (id TEXT, created_at TEXT)`             | `CREATE TABLE ServiceAccounts (ID TEXT, dispName TEXT)` |
| `z.date()` for internal models, `z.iso.datetime()` for API validation | Store local timezone dates                              |
| Accept flexible input, normalize to UTC                               | Use ambiguous date formats (`01/02/2025`)               |

**Zod Patterns**:

```typescript
// Internal models (Date objects)
createdAt: z.date()
expiresAt: z.date().optional()

// API validation (ISO strings, UTC only)
timestamp: z.iso.datetime() // "2024-01-15T10:30:00Z"
timestamp: z.iso.datetime({ offset: true }) // allows "+02:00"
```

**Rationale**: ADR-0009 ensures consistency. UTC eliminates timezone ambiguity across distributed systems. The `At`/`_at` suffix signals "this is a timestamp" to developers.

**Compliance Check**: Do table/column names follow snake_case singular conventions? No local timezone storage? Timestamps use `At`/`_at` suffix?

**ADR Reference**: [ADR-0009](../docs/adr/0009-relational-database-style-guide.md)

---

### XII. Test-Driven Development

**Statement**: Write tests before implementation when possible. Follow red → green → refactor cycle. Core logic needs unit tests. Auth and peering flows need E2E tests. Untested code doesn't ship.

| DO                                            | DON'T                                      |
| --------------------------------------------- | ------------------------------------------ |
| Write failing test first, then implement      | Write code first, tests as afterthought    |
| Unit test `handleAction()` cases              | Ship auth without testing token validation |
| E2E test bootstrap → login → auth call        | Skip tests for "small changes"             |
| E2E test peer connect → exchange → disconnect | Assume manual testing is sufficient        |
| Let tests drive interface design              | Design interfaces in isolation             |
| Bug fixes include regression test             | Refactor and add features simultaneously   |

**Test File Naming**: `*.test.ts` (unit), `*.integration.test.ts` (cross-package), `*.topology.test.ts` (orchestrator/peering).

**Rationale**: TDD produces cleaner APIs (tests reveal awkward interfaces), higher coverage, and prevents gold-plating. POC becomes production — tests now prevent regressions later.

**Compliance Check**: New features have tests committed before or with implementation; bug fixes include regression test; auth/peering changes have E2E tests.

---

### XIII. Small PRs & Graphite Workflow

**Statement**: PRs should be under 600 lines and contain one logical change. All branching, committing, and submitting MUST use Graphite (`gt`) commands — not raw `git commit` or `git push`. Stacked PRs are the default workflow.

| DO                                         | DON'T                                         |
| ------------------------------------------ | --------------------------------------------- |
| Split: models PR → bootstrap PR → login PR | 2000-line "add everything" PR                 |
| One feature or one bug fix per PR          | Mix refactoring with new features             |
| Stack PRs with clear dependencies          | Batch unrelated changes together              |
| `gt add <files>` then `gt create -m "…"`   | `git commit -m "…"` (bypasses Graphite)       |
| `gt submit` immediately after `gt create`  | Forgetting to push — PRs need team visibility |
| `gt sync` to rebase on trunk               | `git rebase main` (breaks stack tracking)     |
| `gt modify` to amend the current branch    | `git commit --amend` (Graphite won't track)   |

**Key Commands**:

```
gt create -m "type(scope): description"   # Stage first, then create stacked branch
gt submit                                  # Push draft PR (run immediately after create)
gt modify -m "updated message"             # Amend current branch
gt sync                                    # Sync with trunk and restack
gt log short                               # View current stack structure
gt fold                                    # Merge current branch into parent
```

**Rationale**: Small PRs review faster, review better, and revert cleanly. Graphite maintains stack integrity — raw git commands break the dependency chain between stacked PRs.

**Compliance Check**: PRs under 600 lines; commits made with `gt create`/`gt modify`, not `git commit`; `gt submit` run after each create.

---

### XIV. Conventional Commits

**Statement**: All commit messages follow the [commitlint conventional](https://www.conventionalcommits.org/) format enforced by commitlint. Messages must be lowercase, max 100 characters for the header, and no trailing period.

**Format**: `type(scope): description`

| Type       | When                                       |
| ---------- | ------------------------------------------ |
| `feat`     | New functionality                          |
| `fix`      | Bug fix                                    |
| `refactor` | Code restructuring without behavior change |
| `test`     | Adding or updating tests                   |
| `docs`     | Documentation changes                      |
| `chore`    | Dependencies, tooling, CI                  |
| `perf`     | Performance improvement                    |

| DO                                                 | DON'T                                                  |
| -------------------------------------------------- | ------------------------------------------------------ |
| `feat(gateway): add telemetry instrumentation`     | `Add telemetry instrumentation to gateway`             |
| `fix(auth): handle expired bootstrap tokens`       | `Fixed bug`                                            |
| `test(orchestrator): add dispatch action coverage` | `tests`                                                |
| `refactor(auth): extract token validation logic`   | `Refactor: Extract Token Validation Logic` (uppercase) |

**Rationale**: Consistent commit messages enable automated changelogs, semantic versioning, and readable `git log` history. commitlint enforces this at the hook level.

**Compliance Check**: Does the commit message match `type(scope): description`? Is the header lowercase and under 100 characters? No trailing period?

---

## Operational Principles

### XV. Security-First

**Statement**: Defense-in-depth across all layers. mTLS (TLS 1.3) for all peer connections. Certificate-bound JWTs with `cnf` claims for peering. Authorization via centralized policy engine (Cedar/Cerbos), not scattered `if` checks. Timing-safe comparisons for all secrets. No hardcoded secrets. Auth context flows through protected paths.

| DO                                                                   | DON'T                                                         |
| -------------------------------------------------------------------- | ------------------------------------------------------------- |
| Require mTLS for all BGP sessions                                    | Skip mTLS for "internal" connections                          |
| Include `cnf.x5t#S256` claim in peering JWTs                         | Issue JWTs without certificate binding for peering            |
| Evaluate authorization via policy engine (principal/resource/action) | Embed authorization in route handlers with ad-hoc role checks |
| `timingSafeEqual(a, b)` for secret comparison                        | `secret === 'value'` (timing attack vulnerable)               |
| Read secrets from `CATALYST_*` env vars                              | `const SECRET = 'hardcoded'` in source                        |
| Thread `AuthContext` through dispatch                                | Ignore auth parameters on protected paths                     |

**Rationale**: Catalyst handles auth tokens and federated trust across organizations. Security bugs compromise the entire mesh. Timing-safe comparisons prevent side-channel attacks on token validation.

**Compliance Check**: No `===` for secrets; no literal secrets; auth params on protected paths; mTLS enforced; JWTs cert-bound where required; authorization delegated to policy engine.

**ADR References**: [ADR-0007](../docs/adr/0007-certificate-bound-access-tokens.md), [ADR-0008](../docs/adr/0008-permission-policy-schema.md)

---

### XVI. Unified Observability via OpenTelemetry

**Statement**: All observability (logs, metrics, traces) MUST flow through the `@catalyst/telemetry` package and the OTEL Collector. No `console.log()`. Logging uses LogTape with template literals and hierarchical categories. Only Apache 2.0/MIT-licensed backends (Prometheus, Jaeger, InfluxDB).

| DO                                                     | DON'T                                                                |
| ------------------------------------------------------ | -------------------------------------------------------------------- |
| `getLogger(['auth', 'jwt'])` with template literals    | `console.log()`, `console.error()`, `console.warn()`                 |
| Push metrics to OTEL Collector                         | Integrate proprietary SDKs (DataDog agent, New Relic agent) directly |
| Hierarchical log categories matching package/component | Flat log prefixes or unstructured messages                           |

**Rationale**: ADR-0001/0002/0003 mandate a single observability pipeline. Direct vendor integrations create lock-in and bypass the collector.

**Compliance Check**: Does this change use `console.log`? Does it bypass the OTEL Collector? Are logging categories hierarchical?

**ADR References**: [ADR-0001](../docs/adr/0001-unified-opentelemetry-observability.md), [ADR-0002](../docs/adr/0002-logging-library-selection.md), [ADR-0003](../docs/adr/0003-observability-backends.md)

---

### XVII. Distributed Systems Awareness

**Statement**: All code must account for distributed system realities: clock skew (30s tolerance for JWTs), network partitions (graceful degradation), eventual consistency (no assumptions of immediate propagation), and idempotent operations where possible.

| DO                                             | DON'T                                                       |
| ---------------------------------------------- | ----------------------------------------------------------- |
| 30-second clock tolerance for JWT verification | Assume synchronized clocks across peers                     |
| Idempotent BGP UPDATE propagation              | Require all peers to acknowledge before considering applied |
| Graceful KEEPALIVE timeout and reconnection    | Assume reliable delivery between nodes                      |

**Rationale**: Catalyst operates across organizations, clouds, and network fabrics. Assumptions of synchrony or reliability will fail at scale.

**Compliance Check**: Does this change assume synchronized state, reliable delivery, or precise clock agreement?

---

## Governance

### Scope

All packages in the `catalyst-node` monorepo.

### Precedence

- This constitution **supersedes** all other guidance when conflicts arise — including preferences, shortcuts, and deadlines
- ADRs elaborate on constitutional principles but cannot contradict them
- CLAUDE.md/GEMINI.md/ and others provide implementation guidance aligned with these principles

### Amendment Process

1. **Propose**: Create a PR to this file with the proposed amendment and rationale
2. **Review**: Requires approval from at least one maintainer
3. **Document**: Record the amendment with date and version bump
4. **Notify**: Update CLAUDE.md/GEMINI.md/ and others if the amendment affects development patterns
5. **Merge**: Merge the PR if approved

### Violation Handling

- Constitutional violations are **CRITICAL** findings in specification review
- Violations **block merge**. No exceptions.
- Emergency exceptions require written justification and a follow-up amendment proposal

### Documentation Duty

When code changes APIs, config, or CLI, update the docs. Docs are part of the deliverable. PRs adding features must include doc updates.

---
