# Catalyst Node Constitution

**Version**: 2.0.0 | **Ratified**: 2026-02-05 | **Last Amended**: 2026-02-06

> This constitution defines the immutable architectural principles, project conventions,
> and development workflow for the Catalyst Node project.
> All specifications, implementation plans, and code changes MUST comply with these principles.
> Violations are CRITICAL findings that block merge. No exceptions.

---

## Quick Reference

| ID   | Principle                     | Category    | Key Rule                                                                |
| ---- | ----------------------------- | ----------- | ----------------------------------------------------------------------- |
| I    | Decentralized Service Routing | Structural  | BGP-inspired L4-7 peering, no centralized routing                       |
| II   | Core Pod Architecture         | Structural  | Orchestrator + sidecars, Capnweb RPC between components                 |
| III  | V2 Dispatch Pattern           | Structural  | `dispatch()` -> `handleAction()` -> `handleNotify()`, not V1 plugins    |
| IV   | Dependency Inversion          | Structural  | Accept interfaces, not concrete implementations                         |
| V    | Package Boundary Integrity    | Structural  | Inward dependencies, no cross-package internal imports                  |
| VI   | ESM Module Conventions        | Structural  | `.js` extensions, `type` imports, kebab-case files                      |
| VII  | Schema-First Validation       | Quality     | Zod schemas on all external boundaries, `z.infer<>` for types           |
| VIII | Discriminated Union Results   | Quality     | `{ success, data/error }` for fallible operations                       |
| IX   | Strict Typing                 | Quality     | No `any`, no `@ts-ignore`, explicit return types on public APIs         |
| X    | Persistent State in SQLite    | Quality     | SQLite via `bun:sqlite`, WAL mode, no in-memory Maps for durable state  |
| XI   | Database Naming Conventions   | Quality     | snake_case, singular tables, `_at` suffix for timestamps                |
| XII  | Test-Driven Development       | Quality     | Red -> green -> refactor; unit + E2E coverage required                  |
| XIII | Small PRs & Graphite          | Quality     | Under 600 lines, `gt` commands only, stacked PRs                        |
| XIV  | Conventional Commits          | Quality     | commitlint format: `type(scope): description`, lowercase, max 100 chars |
| XV   | Security-First                | Operational | mTLS, cert-bound JWTs, timing-safe comparisons, policy engine           |
| XVI  | Unified Observability (OTEL)  | Operational | LogTape + OTEL Collector, no `console.log`, Apache 2.0/MIT backends     |
| XVII | Distributed Systems Awareness | Operational | 30s clock tolerance, idempotent ops, graceful degradation               |

---

# PART I: Architectural Principles

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

**Statement**: The two-phase dispatch pattern in `CatalystNodeBus` is canonical. V1 plugin interfaces are deprecated. All control plane actions flow through `dispatch()` -> `handleAction()` (pure state transitions) -> `handleNotify()` (side effects).

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

**ADR Reference**: [ADR-0004](docs/adr/0004-sqlite-storage-backend.md)

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

**ADR Reference**: [ADR-0009](docs/adr/0009-relational-database-style-guide.md)

---

### XII. Test-Driven Development

**Statement**: Write tests before implementation when possible. Follow red -> green -> refactor cycle. Core logic needs unit tests. Auth and peering flows need E2E tests. Untested code doesn't ship.

| DO                                              | DON'T                                      |
| ----------------------------------------------- | ------------------------------------------ |
| Write failing test first, then implement        | Write code first, tests as afterthought    |
| Unit test `handleAction()` cases                | Ship auth without testing token validation |
| E2E test bootstrap -> login -> auth call        | Skip tests for "small changes"             |
| E2E test peer connect -> exchange -> disconnect | Assume manual testing is sufficient        |
| Let tests drive interface design                | Design interfaces in isolation             |
| Bug fixes include regression test               | Refactor and add features simultaneously   |

**Test File Naming**: `*.test.ts` (unit), `*.integration.test.ts` (cross-package), `*.topology.test.ts` (orchestrator/peering).

**Rationale**: TDD produces cleaner APIs (tests reveal awkward interfaces), higher coverage, and prevents gold-plating. POC becomes production — tests now prevent regressions later.

**Compliance Check**: New features have tests committed before or with implementation; bug fixes include regression test; auth/peering changes have E2E tests.

---

### XIII. Small PRs & Graphite Workflow

**Statement**: PRs should be under 600 lines and contain one logical change. All branching, committing, and submitting MUST use Graphite (`gt`) commands — not raw `git commit` or `git push`. Stacked PRs are the default workflow.

| DO                                           | DON'T                                         |
| -------------------------------------------- | --------------------------------------------- |
| Split: models PR -> bootstrap PR -> login PR | 2000-line "add everything" PR                 |
| One feature or one bug fix per PR            | Mix refactoring with new features             |
| Stack PRs with clear dependencies            | Batch unrelated changes together              |
| `git add <files>` then `gt create -m "..."`  | `git commit -m "..."` (bypasses Graphite)     |
| `gt submit` immediately after `gt create`    | Forgetting to push — PRs need team visibility |
| `gt sync` to rebase on trunk                 | `git rebase main` (breaks stack tracking)     |
| `gt modify` to amend the current branch      | `git commit --amend` (Graphite won't track)   |

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

**ADR References**: [ADR-0007](docs/adr/0007-certificate-bound-access-tokens.md), [ADR-0008](docs/adr/0008-permission-policy-schema.md)

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

**ADR References**: [ADR-0001](docs/adr/0001-unified-opentelemetry-observability.md), [ADR-0002](docs/adr/0002-logging-library-selection.md), [ADR-0003](docs/adr/0003-observability-backends.md)

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

# PART II: Project Reference

## Project Overview

**Core Mission:** Decentralized service routing without centralized coordination — like BGP for services.

Catalyst Node is a distributed control and data plane system that bridges organizations, clouds, and disparate network fabrics. It enables secure service peering across trust boundaries using a BGP-inspired protocol for Layers 4-7 service mesh.

### Tech Stack

| Category      | Technology                                       |
| ------------- | ------------------------------------------------ |
| Language      | TypeScript (ES2022 target, strict mode)          |
| Runtime       | Bun (primary), Node.js compatible                |
| Module System | ESM (`"type": "module"`)                         |
| Web Framework | Hono                                             |
| GraphQL       | GraphQL Yoga + @graphql-tools (federation)       |
| RPC           | Capnweb (WebSockets + Cap'n Proto)               |
| Validation    | Zod                                              |
| Auth/Crypto   | jose (JWT), argon2 (passwords), Cedar (policies) |
| Data Plane    | Envoy Proxy (via xDS)                            |
| Database      | SQLite (via Bun native bindings)                 |

---

## Project Structure

```
catalyst-node/
├── packages/
│   ├── node/           # @catalyst/node - Main orchestrator entry point
│   ├── gateway/        # @catalyst/gateway - GraphQL federation engine
│   ├── auth/           # @catalyst/auth - Identity & crypto service
│   ├── cli/            # @catalyst/cli - Command-line interface
│   ├── orchestrator/   # @catalyst/orchestrator - Control plane logic
│   ├── sdk/            # @catalyst/sdk - Client SDK
│   ├── config/         # @catalyst/config - Shared configuration schemas
│   ├── authorization/  # @catalyst/authorization - RBAC/policy engine
│   ├── telemetry/      # @catalyst/telemetry - Unified observability (OTEL)
│   ├── types/          # @catalyst/types - Shared result types (Result, ValidationResult)
│   ├── peering/        # Peer-to-peer networking
│   └── examples/       # Sample GraphQL services (books, movies)
├── docker-compose/     # Container orchestration configs
├── docs/               # Documentation & ADRs
└── scripts/            # Utility scripts
```

---

## Code Style & Conventions

### Formatting (Prettier)

- No semicolons
- Single quotes
- 2-space indentation
- Trailing commas (ES5)
- 100 character line width

### TypeScript Rules

- Strict mode enabled
- Use `type` imports: `import type { Foo } from './foo.js'`
- No explicit `any` (warn)
- Unused variables prefixed with `_` are allowed

### Naming Conventions

- Files: kebab-case (`jwt-handler.ts`)
- Types/Interfaces: PascalCase (`SignOptions`)
- Functions/Variables: camelCase (`signToken`)
- Constants: SCREAMING_SNAKE_CASE for true constants
- Schema suffix: `*Schema` for Zod schemas (`SignOptionsSchema`)

---

## Code Patterns

### Module Pattern

```typescript
// Always use .js extension in imports (ESM requirement)
export * from './jwt.js'
export { signToken, verifyToken } from './jwt.js'
export type { SignOptions, VerifyOptions } from './jwt.js'
```

### Zod Schema Pattern

```typescript
const SignOptionsSchema = z.object({
  subject: z.string(),
  audience: z.string().or(z.array(z.string())).optional(),
  expiresIn: z.string().optional(),
  claims: z.record(z.string(), z.unknown()).optional(),
})
export type SignOptions = z.infer<typeof SignOptionsSchema>
```

### Discriminated Union Pattern (API Responses)

```typescript
const ResponseSchema = z.discriminatedUnion('success', [
  z.object({ success: z.literal(true), data: DataSchema }),
  z.object({ success: z.literal(false), error: z.string() }),
])
```

### Error Handling Pattern

Use the shared result types from `@catalyst/types`:

```typescript
import type { Result, OptionalResult, ValidationResult } from '@catalyst/types'
import { createResultSchema, createValidationResultSchema } from '@catalyst/types'

// For operations that return data on success
type Result<T> = { success: true; data: T } | { success: false; error: string }

// For operations that may not return data (delete, update)
type OptionalResult<T> = { success: true; data?: T } | { success: false; error: string }

// For validation operations (uses 'valid' discriminator)
type ValidationResult<T> = { valid: true; payload: T } | { valid: false; error: string }

// Create Zod schemas for these types
const UserResultSchema = createResultSchema(UserSchema)
const TokenValidationSchema = createValidationResultSchema(PayloadSchema)
```

### Hono Route Pattern

```typescript
const app = new Hono()
app.get('/health', (c) => c.json({ status: 'ok' }))
app.route('/graphql', graphqlApp)
app.route('/api', rpcApp)
export default { fetch: app.fetch, port, hostname }
```

### RPC Server Pattern (Capnweb)

```typescript
import { RpcTarget } from 'capnweb'
import { newRpcResponse } from '@hono/capnweb'
import { upgradeWebSocket } from 'hono/bun'

// RPC servers must extend RpcTarget
export class MyRpcServer extends RpcTarget {
  constructor(private callback: SomeCallback) {
    super() // Required: call super()
  }

  // Public methods are exposed as RPC endpoints
  async myMethod(input: unknown): Promise<MyResult> {
    const result = MyInputSchema.safeParse(input)
    if (!result.success) {
      return { success: false, error: 'Invalid input' }
    }
    return { success: true, data: result.data }
  }
}

// Create Hono handler for the RPC server
export function createRpcHandler(rpcServer: MyRpcServer): Hono {
  const app = new Hono()
  app.get('/', (c) => {
    return newRpcResponse(c, rpcServer, { upgradeWebSocket })
  })
  return app
}
```

### Configuration Loading

```typescript
import { loadDefaultConfig, CatalystConfigSchema } from '@catalyst/config'

const config = loadDefaultConfig() // Reads from environment
// Or validate custom config
const validated = CatalystConfigSchema.parse(rawConfig)
```

### JWT Operations

```typescript
// Duration strings: '1h', '7d', '30m'
// Reserved claims (iss, sub, aud, exp, nbf, iat, jti) cannot be overridden
// Clock tolerance: 30 seconds for distributed systems
```

### Plugin Architecture

The orchestrator uses plugins for extensibility:

- `IRouteTablePlugin` — Route table modifications
- `IServicePlugin` — Service discovery
- `IPropagationPlugin` — Cross-peer propagation

---

## Testing

### Test Frameworks

- **Primary:** `bun:test` (native Bun test runner)
- **Alternative:** Vitest (for packages requiring coverage)
- **Integration:** testcontainers (Docker-based)
- **E2E:** Playwright

### Test File Naming

- Unit tests: `*.test.ts` or `*.unit.test.ts`
- Topology tests: `*.topology.test.ts`
- Integration tests: `*.integration.test.ts` or `*.container.test.ts`
- E2E tests: `e2e/**/*.test.ts`

### Running Tests

```bash
# Run all tests in a package
bun test packages/auth

# Run with watch mode
bun test --watch packages/auth

# Run container tests (requires Docker)
CATALYST_CONTAINER_TESTS_ENABLED=true bun test packages/cli

# Run vitest packages
bun run test --filter @catalyst/node
bun run test --filter @catalyst/sdk
```

### Test Helper Pattern

```typescript
function expectValid(result: VerifyResult) {
  expect(result.valid).toBe(true)
  return (result as { valid: true; payload: Record<string, unknown> }).payload
}

function expectInvalid(result: VerifyResult) {
  expect(result.valid).toBe(false)
  return (result as { valid: false; error: string }).error
}
```

---

## Development Commands

### Root Commands

```bash
bun run lint              # Lint all files
bun run lint:fix          # Fix lint issues
bun run format            # Format with Prettier
bun run format:check      # Check formatting
bun run cli               # Run CLI tool
bun run start:m0p2        # Start Docker Compose example
```

### Package-Specific

```bash
# Development mode (with watch)
bun run dev --filter @catalyst/auth
bun run dev --filter @catalyst/gateway

# Build
bun run build --filter @catalyst/node
bun run build --filter @catalyst/sdk

# Start
bun run start --filter @catalyst/auth
```

---

## Environment Variables

### Node Configuration

```bash
CATALYST_NODE_ID=node-1              # Required: Node identifier
CATALYST_PEERING_ENDPOINT=ws://...   # Peer URL
CATALYST_DOMAINS=example.com,api.io  # Comma-separated domains
```

### Auth Service

```bash
CATALYST_AUTH_ISSUER=catalyst        # JWT issuer
CATALYST_AUTH_KEYS_DB=keys.db        # Keys database path
CATALYST_AUTH_TOKENS_DB=tokens.db    # Tokens database path
CATALYST_BOOTSTRAP_TOKEN=secret      # First-admin bootstrap token
CATALYST_BOOTSTRAP_TTL=300000        # Bootstrap TTL (ms)
```

### Orchestrator

```bash
CATALYST_ORCHESTRATOR_URL=ws://...   # Orchestrator RPC endpoint
CATALYST_GQL_GATEWAY_ENDPOINT=http://... # GraphQL gateway
```

---

## Git Workflow (Graphite)

This project uses **Graphite** for stacked PRs. PRs form a linked list of changes where each PR builds on the previous one.

**IMPORTANT: Always use Graphite (`gt`) commands instead of raw `git` commands for branching, committing, and pushing.**

### Understanding the Stack

```bash
gt log short          # View current stack structure
gt stack              # See all branches in your stack
gt branch info        # Info about current branch
```

### Common Workflow

```bash
# Stage changes first (gt create doesn't auto-stage in current version)
git add <files>

# Create new stacked branch/commit
gt create -m "feat: add feature"

# IMPORTANT: Submit immediately after creating to push draft PR for team visibility
gt submit  # or gt s for short

# Other useful commands
gt modify -m "update message"      # Amend current branch (stages all changes)
gt sync                            # Sync with trunk and restack
```

**Key Points:**

- **Always run `gt submit` (or `gt s`) immediately after `gt create`** — PRs are created as drafts and submitting them provides team visibility
- Stage changes with `git add` before `gt create` (current Graphite version doesn't auto-stage)
- `gt modify` automatically stages ALL changes when amending the current branch
- Use `gt` commands exclusively for commits to maintain stack integrity
- Draft PRs allow the team to see work in progress without blocking reviews

### Fixing Empty or Duplicate PRs

If you end up with an empty PR or duplicate branches:

```bash
# Option 1: Fold - merge current branch into its parent
gt fold                            # Merges current branch commits into parent branch

# Option 2: Move + Delete - move branch onto another, then delete
gt branch checkout <target-branch> # Switch to the branch you want to keep
gt move <source-branch>            # Move source branch's commits onto current branch
gt branch delete <source-branch>   # Delete the now-empty branch
```

---

## Architecture Decision Records (ADRs)

ADRs live in `docs/adr/` and define technical standards. **Always check relevant ADRs before implementation.**

| ADR  | Title                               | Status   | Key Requirement                                                                  |
| ---- | ----------------------------------- | -------- | -------------------------------------------------------------------------------- |
| 0001 | Unified OpenTelemetry Observability | Accepted | Use `@catalyst/telemetry` for all observability; OTEL Collector as single egress |
| 0002 | Logging Library Selection           | Accepted | Use LogTape with template literals: `logger.info\`message ${var}\``              |
| 0003 | Observability Backends              | Proposed | Only Apache 2.0/MIT licensed backends (Prometheus, Jaeger, InfluxDB)             |
| 0004 | SQLite Storage Backend              | Accepted | All persistent state in SQLite via `bun:sqlite`, not in-memory Maps              |
| 0005 | Docker as Container Runtime         | Accepted | Docker Desktop for dev, Docker Engine for CI; no Podman/Colima                   |
| 0006 | Node Orchestrator Architecture      | Accepted | dispatch -> handleAction -> handleNotify pipeline; V2 replaces V1 plugins        |
| 0007 | Certificate-Bound Access Tokens     | Proposed | JWT must include `cnf` claim with cert thumbprint for BGP peering                |
| 0008 | Permission Policy Schema            | Proposed | Use Cerbos for ABAC; policies in YAML at `packages/auth/cerbos/policies/`        |
| 0009 | Relational Database Style Guide     | Accepted | snake_case, singular tables, descriptive columns, UTC dates                      |

### ADR-Enforced Patterns

**Observability (ADR-0001, 0002, 0003):**

- Initialize telemetry first: `import { initTelemetry } from '@catalyst/telemetry'`
- No `console.log()` — use LogTape logger
- Hierarchical log categories: `getLogger(['service', 'component'])`
- Only Apache 2.0/MIT licensed backends

**Storage (ADR-0004):**

- Stores must implement abstract interface (e.g., `UserStore`)
- Support both `InMemoryStore` (tests) and `SqliteStore` (production)
- SQLite pragmas: WAL mode, foreign keys ON, busy_timeout 5000

**Auth (ADR-0007, 0008):**

- JWT `cnf` claim required for peering tokens
- Authorization via Cerbos PDP, not scattered logic
- Policies version-controlled in YAML

**Container Runtime (ADR-0005):**

- Docker Desktop for local development
- Docker Engine for CI/CD
- No alternative runtimes (Podman, Colima)

**Orchestrator Architecture (ADR-0006):**

- `dispatch()` -> `handleAction()` -> `handleNotify()` pipeline
- V1 plugin interfaces deprecated
- All state mutations through dispatch

**Database Naming (ADR-0009):**

- snake_case, singular table names
- Descriptive column names, no abbreviations
- `_at` suffix for timestamp columns
- UTC dates stored as ISO 8601

---

## Key Documentation

- `ARCHITECTURE.md` — System design and component overview
- `SECURITY.md` — Security protocols, mTLS, JWT strategies
- `BGP_PROTOCOL.md` — BGP message types and semantics
- `TECH_STACK.md` — Technology choices and rationales
- `docs/adr/` — Architecture Decision Records
- `packages/*/README.md` — Package-specific documentation

---

# PART III: Development Workflow

## Philosophy

- **Documentation-First Development:** Before writing any code, understand the existing context — scope, documentation, and ADRs. This prevents wasted effort and ensures changes align with established patterns.
- **Parallel Where Possible, Sequential Where Required:** Research and analysis can happen in parallel. Verification steps run sequentially (fail-fast).
- **Living Documentation:** Implementation changes should consider whether docs need updates. Documentation is part of the deliverable.

---

## Task Classification

Before starting work, classify the change to determine the appropriate level of preparation and verification.

| Change Type   | Pre-Work Required                  | Verification Level            | Typical Scope        |
| ------------- | ---------------------------------- | ----------------------------- | -------------------- |
| PR Fix        | Scope check only                   | Lint + types + targeted tests | Single file/function |
| New Feature   | Full (scope + docs + ADR)          | Full verification chain       | Single package       |
| Migration     | Full + cross-package impact        | Full + integration tests      | Multi-package        |
| Exploration   | Documentation review               | None (read-only)              | N/A                  |
| Architecture  | Documentation + ADR review         | None (produces decision doc)  | Decision doc / ADR   |
| Documentation | None                               | Format check                  | Docs only            |
| Cleanup       | Scope check + cross-package impact | Full verification chain       | Single package       |

### What to Understand Before Starting Each Type

**PR Fix:** What is the feedback? Which file(s) are involved? Is it a code change, style fix, missing test, or documentation update?

**New Feature:** What is being built (1-2 sentences)? Which package(s) will it touch? Are there similar features to reference? Scope type: RPC endpoint, CLI command, internal logic, cross-package, or external API?

**Migration:** What is being migrated from/to? How many files are affected? Is this a breaking change? Can it be phased?

**Exploration:** What do you want to understand? Which specific component, flow, or pattern? Why? (Focus helps exploration.)

**Architecture:** What decision needs to be made? What options are being considered? What are the constraints? Who needs to approve?

**Documentation:** Which docs need updating? What is unclear or missing? Is code changing too, or just docs?

**Cleanup:** What needs to be removed? Why is it no longer needed? Are you sure it is unused?

---

## Development Phases

### Phase 1: Pre-Work (Context Gathering)

Before writing any code, gather context. Not all steps are needed for every task type — see the Task Classification table above.

#### Scope Analysis

Understand the current branch/PR scope before changing anything:

1. Check the current branch and its position in the stack (`gt log short`)
2. Identify files already modified in this PR (`git diff --name-only`)
3. Determine whether the planned change fits the current PR's intent
4. If the change is out of scope, create a new stacked PR instead

#### Documentation Review

Read documentation relevant to the task area:

- `ARCHITECTURE.md` — if touching system design or component interactions
- `SECURITY.md` — if touching auth, crypto, peering, or tokens
- `BGP_PROTOCOL.md` — if touching peering, routing, or propagation
- `TECH_STACK.md` — if choosing libraries or patterns
- `packages/[name]/README.md` — for package-specific context

Extract: key patterns that apply, constraints or "don't do this" guidance, terminology to use consistently, and open TODOs.

#### ADR Compliance Check

Read relevant ADRs in `docs/adr/` and verify:

1. Which ADRs apply to this task?
2. Does the planned approach comply?
3. What specific requirements must be met?
4. If non-compliant, what needs to change — the approach or the ADR?

#### Cross-Package Impact Analysis

When modifying shared code (`@catalyst/config`, `@catalyst/sdk`, shared utilities):

1. Find all imports of the affected files/symbols across packages
2. Find all usages of affected types/functions
3. Identify which packages need updates
4. Check which tests would break
5. Check if docs reference the changed code

#### Pre-Work Matrix

| Task Type     | Scope Analysis | Doc Review | ADR Check | Cross-Pkg Impact    |
| ------------- | -------------- | ---------- | --------- | ------------------- |
| PR Fix        | Yes            | No         | No        | No                  |
| New Feature   | Yes            | Yes        | Yes       | Only if shared code |
| Migration     | Yes            | Yes        | Yes       | Yes                 |
| Exploration   | No             | Yes        | No        | No                  |
| Architecture  | No             | Yes        | Yes       | No                  |
| Documentation | No             | No         | No        | No                  |
| Cleanup       | Yes            | No         | No        | Yes                 |

#### Blocker Handling

If pre-work reveals blockers (scope conflicts, ADR violations, breaking changes), **stop and resolve them before proceeding**:

1. Present the blocker clearly with the specific issue and resolution options
2. Scope conflicts: create a new stacked PR
3. ADR violations: change the approach to comply, or propose an ADR amendment
4. Breaking changes: assess whether to expand scope to include all affected packages

---

### Phase 2: Implementation

With pre-work context in hand:

- Stay within the scope boundaries identified in Phase 1
- Follow the patterns discovered in documentation review
- Comply with applicable ADRs
- If scope creep is detected during implementation, split into a new stacked PR
- Keep PRs focused — one logical change per PR (Principle XIII)

---

### Phase 3: Verification

After implementation, run verification appropriate to the task type. Execute sequentially and **stop on first failure**.

#### Verification Chain

```
1. bun run lint           # Lint check
2. bun run format:check   # Format check
3. tsc --noEmit           # Type check
4. bun test [package]     # Unit tests (parallel across packages OK)
5. Integration tests      # If touching cross-package boundaries
6. Container tests        # If touching RPC/networking (CATALYST_CONTAINER_TESTS_ENABLED=true)
7. Topology tests         # If touching orchestrator/peering logic
```

#### Verification Matrix

| Task Type     | Lint | Format | Types | Unit Tests | Integration  | Container | Topology |
| ------------- | ---- | ------ | ----- | ---------- | ------------ | --------- | -------- |
| PR Fix        | Yes  | Yes    | Yes   | Yes        | No           | No        | No       |
| New Feature   | Yes  | Yes    | Yes   | Yes        | If cross-pkg | If RPC    | If orch  |
| Migration     | Yes  | Yes    | Yes   | Yes        | Yes          | If RPC    | If orch  |
| Exploration   | No   | No     | No    | No         | No           | No        | No       |
| Architecture  | No   | No     | No    | No         | No           | No        | No       |
| Documentation | Yes  | Yes    | No    | No         | No           | No        | No       |
| Cleanup       | Yes  | Yes    | Yes   | Yes        | Yes          | No        | No       |

#### Failure Reporting

When verification fails, report clearly:

```
FAILED: [step name]
Package: [package name]
File: [path:line]
Error: [error message]
Suggestion: [fix if obvious]
```

Aggregate failures across packages:

```
@catalyst/auth: 2 failures
  - signToken.test.ts: expected token to include cnf claim
  - verifyToken.test.ts: timeout exceeded
@catalyst/gateway: 1 failure
  - reload.test.ts: schema mismatch
```

---

### Phase 4: Documentation Sync

After implementation, check if documentation needs updates.

#### When to Check

- **PR Fix**: Only if behavior changed (not just style/types)
- **New Feature**: Always
- **Migration**: Always
- **Exploration**: Never
- **Architecture**: Only if creating new ADR
- **Documentation**: N/A (already docs-focused)
- **Cleanup**: Only if removed public APIs

#### What to Check

1. Does this constitution need pattern updates?
2. Do any ADRs need amendments?
3. Does `ARCHITECTURE.md` need updates?
4. Do package READMEs need updates?
5. Are there inline code comments that are now stale?

#### When Patterns Change

- If you established a new pattern, propose adding it to this constitution
- If you deviated from an ADR, propose an ADR amendment
- If you discovered an undocumented pattern, suggest documenting it

---

## Prompt Best Practices for AI-Assisted Development

When working with AI assistants on this codebase, follow these practices for best results:

**Be Specific About Scope:**

```
Bad:  "Check the docs"
Good: "Read SECURITY.md and ADR-0007, focusing on JWT claim requirements
       for the token rotation feature"
```

**State Your Intent:**

```
Bad:  "What does the auth package do?"
Good: "I need to add a token rotation endpoint. What existing patterns
       in @catalyst/auth should I follow for RPC endpoints?"
```

**Provide Context:**

```
Bad:  "Run the tests"
Good: "Run tests for @catalyst/auth after modifying signToken() to
       include the cnf claim. Focus on signing and verification tests."
```

**Request Actionable Output:**

```
Bad:  "Is this ADR compliant?"
Good: "Check ADR-0002 compliance for my logging approach. If non-compliant,
       provide the specific code changes needed."
```

---

# PART IV: Governance

### Scope

All packages in the `catalyst-node` monorepo.

### Precedence

- This constitution **supersedes** all other guidance when conflicts arise — including preferences, shortcuts, and deadlines
- ADRs elaborate on constitutional principles but cannot contradict them
- Tool-specific configuration files provide implementation guidance aligned with these principles

### Amendment Process

1. **Propose**: Create a PR to this file with the proposed amendment and rationale
2. **Review**: Requires approval from at least one maintainer
3. **Document**: Record the amendment with date and version bump
4. **Notify**: Update tool-specific configuration files if the amendment affects development patterns
5. **Merge**: Merge the PR if approved

### Violation Handling

- Constitutional violations are **CRITICAL** findings in specification review
- Violations **block merge**. No exceptions.
- Emergency exceptions require written justification and a follow-up amendment proposal

### Documentation Duty

When code changes APIs, config, or CLI, update the docs. Docs are part of the deliverable. PRs adding features must include doc updates.
