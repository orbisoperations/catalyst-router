# CLAUDE.md - Catalyst Node Development Guide

## Project Overview

Catalyst Node is a distributed control and data plane system that bridges organizations, clouds, and disparate network fabrics. It enables secure service peering across trust boundaries using a BGP-inspired protocol for Layers 4-7 service mesh.

**Core Mission:** Decentralized service routing without centralized coordination—like BGP for services.

## Tech Stack

- **Language:** TypeScript (ES2022 target, strict mode)
- **Runtime:** Bun (primary), Node.js compatible
- **Module System:** ESM (`"type": "module"`)
- **Web Framework:** Hono
- **GraphQL:** GraphQL Yoga + @graphql-tools (federation/stitching)
- **RPC:** Capnweb (WebSockets + Cap'n Proto)
- **Validation:** Zod
- **Auth/Crypto:** jose (JWT), argon2 (passwords), Cedar (policies)
- **Data Plane:** Envoy Proxy (via xDS)
- **Database:** SQLite (via Bun native bindings)

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
│   ├── peering/        # Peer-to-peer networking
│   └── examples/       # Sample GraphQL services (books, movies)
├── docker-compose/     # Container orchestration configs
├── docs/               # Documentation & ADRs
└── scripts/            # Utility scripts
```

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

### Discriminated Union Pattern (for API responses)

```typescript
const ResponseSchema = z.discriminatedUnion('success', [
  z.object({ success: z.literal(true), data: DataSchema }),
  z.object({ success: z.literal(false), error: z.string() }),
])
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
    // Validate input with Zod
    const result = MyInputSchema.safeParse(input)
    if (!result.success) {
      return { success: false, error: 'Invalid input' }
    }
    // Process and return discriminated union result
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

## Commit Convention

Using Conventional Commits:

```
feat: add user authentication
fix: resolve token expiration bug
docs: update API documentation
refactor: simplify key rotation logic
test: add integration tests for peering
chore: update dependencies
```

- Subject must be lowercase
- Max 100 characters for header
- No period at end

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

- **Always run `gt submit` (or `gt s`) immediately after `gt create`** - PRs are created as drafts and submitting them provides team visibility
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

**When to use each:**

- `gt fold`: When you want to merge the current branch into its parent (simplest for adjacent branches)
- `gt move + delete`: When you need more control over which branch receives the commits

### Scoping Changes

When reviewing or working on changes:

- Use `gt log` to understand what's in the current stack
- Each PR should be a logical, reviewable unit
- Changes in lower stack PRs affect all PRs above them
- Keep PRs focused—easier to review and less rebase pain

## Key Documentation

- `ARCHITECTURE.md` - System design and component overview
- `SECURITY.md` - Security protocols, mTLS, JWT strategies
- `BGP_PROTOCOL.md` - BGP message types and semantics
- `TECH_STACK.md` - Technology choices and rationales
- `CLAUDE_AGENTS.md` - Subagent definitions, prompts, and workflow examples
- `.claude/` - Agent definition files and Claude Code settings
- `docs/adr/` - Architecture Decision Records
- `packages/*/README.md` - Package-specific documentation

## Important Patterns

### Error Handling

Always use discriminated unions for operation results:

```typescript
type Result<T> = { success: true; data: T } | { success: false; error: string }
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

- `IRouteTablePlugin` - Route table modifications
- `IServicePlugin` - Service discovery
- `IPropagationPlugin` - Cross-peer propagation

## AI Assistant Guidelines

When working on this codebase:

1. **Prefer functional patterns** - Pure functions, immutable data
2. **Always validate with Zod** - Use schemas for all external data
3. **Use discriminated unions** - For success/failure responses
4. **Include .js extensions** - Required for ESM imports
5. **Write tests** - At minimum, unit tests for new functions
6. **Follow existing patterns** - Check similar files for conventions
7. **Update schemas** - When modifying data structures
8. **Consider distributed context** - Clock skew, network partitions, eventual consistency
9. **Security first** - mTLS, JWT validation, policy enforcement
10. **RPC servers must extend `RpcTarget`** - Import from `capnweb`, call `super()` in constructor, public methods become RPC endpoints
11. **Be stack-aware** - Use `gt log short` to understand current Graphite stack scope before making changes; keep changes focused to the current PR's intent
12. **ADR compliance** - Check relevant ADRs before implementation; propose ADR updates when deviating

## Architecture Decision Records (ADRs)

ADRs live in `docs/adr/` and define technical standards. **Always check relevant ADRs before implementation.**

| ADR  | Title                               | Status   | Key Requirement                                                                  |
| ---- | ----------------------------------- | -------- | -------------------------------------------------------------------------------- |
| 0001 | Unified OpenTelemetry Observability | Accepted | Use `@catalyst/telemetry` for all observability; OTEL Collector as single egress |
| 0002 | Logging Library Selection           | Accepted | Use LogTape with template literals: `logger.info\`message ${var}\``              |
| 0003 | Observability Backends              | Proposed | Only Apache 2.0/MIT licensed backends (Prometheus, Jaeger, InfluxDB)             |
| 0004 | SQLite Storage Backend              | Accepted | All persistent state in SQLite via `bun:sqlite`, not in-memory Maps              |
| 0007 | Certificate-Bound Access Tokens     | Proposed | JWT must include `cnf` claim with cert thumbprint for BGP peering                |
| 0008 | Permission Policy Schema            | Proposed | Use Cerbos for ABAC; policies in YAML at `packages/auth/cerbos/policies/`        |

### ADR-Enforced Patterns

**Observability (ADR-0001, 0002):**

- Initialize telemetry first: `import { initTelemetry } from '@catalyst/telemetry'`
- No `console.log()` — use LogTape logger
- Hierarchical log categories: `getLogger(['service', 'component'])`

**Storage (ADR-0004):**

- Stores must implement abstract interface (e.g., `UserStore`)
- Support both `InMemoryStore` (tests) and `SqliteStore` (production)
- SQLite pragmas: WAL mode, foreign keys ON, busy_timeout 5000

**Auth (ADR-0007, 0008):**

- JWT `cnf` claim required for peering tokens
- Authorization via Cerbos PDP, not scattered logic
- Policies version-controlled in YAML

## Subagent Strategy

> **Full details:** See `CLAUDE_AGENTS.md` for complete agent definitions, prompt templates, and workflow examples.
>
> **Invoke with:** `/orbi [task description]` (explicit) or `Orbi [task description]` (natural language) — The orchestrator will identify task type and guide you through the appropriate workflow.

### Task Types

| Trigger                   | Type             | Pre-Work     | Verification |
| ------------------------- | ---------------- | ------------ | ------------ |
| `/orbi fix PR comment...` | 🔧 PR Fix        | Stack scope  | Minimal      |
| `/orbi add feature...`    | ✨ New Feature   | Full         | Full         |
| `/orbi migrate...`        | 🔄 Migration     | Impact + ADR | Full         |
| `/orbi how does...`       | 🔍 Exploration   | None         | None         |
| `/orbi should we...`      | 🏗️ Architecture  | Docs + ADR   | None         |
| `/orbi document...`       | 📝 Documentation | Doc sync     | Minimal      |
| `/orbi cleanup...`        | 🧹 Cleanup       | Impact       | Full         |

### Pre-Work Phase (ALWAYS)

Before any implementation, spawn parallel exploration agents:

```
1. Stack Scope Agent     → `gt log short` to understand current PR scope
2. Documentation Agent   → Read relevant docs (ARCHITECTURE.md, SECURITY.md, etc.)
3. ADR Compliance Agent  → Read relevant ADRs in docs/adr/
```

**Goal:** Understand intent before changing anything. Either reinforce documented patterns or propose updates.

### Implementation Phase

Keep changes focused to current stack scope. If scope creep detected, suggest creating a new stacked PR.

### Verification Phase (Sequential)

Run verification in this order—stop on first failure:

```
1. bun run lint           # Lint check
2. bun run format:check   # Format check
3. tsc --noEmit           # Type check
4. bun test [package]     # Unit tests (parallel across packages OK)
5. Integration tests      # If touching cross-package boundaries
6. Container tests        # If touching RPC/networking (CATALYST_CONTAINER_TESTS_ENABLED=true)
7. Topology tests         # If touching orchestrator/peering logic
```

**Parallel test execution:** OK across packages, but aggregate failures clearly:

```
❌ @catalyst/auth: 2 failures
  - signToken.test.ts: expected token to include cnf claim
  - verifyToken.test.ts: timeout exceeded
❌ @catalyst/gateway: 1 failure
  - reload.test.ts: schema mismatch
```

### Documentation Sync Phase

After implementation, check if docs need updates:

- Did behavior change? → Update relevant `.md` files
- Did you deviate from an ADR? → Propose ADR amendment or new ADR
- Did you establish a new pattern? → Suggest CLAUDE.md update

### Continuous Improvement

When technical patterns emerge from ADRs or implementation:

1. **Extract to CLAUDE.md** — If an ADR defines code patterns, add them here
2. **Keep in sync** — When ADRs change, update corresponding CLAUDE.md sections
3. **Suggest updates** — Proactively recommend CLAUDE.md changes when patterns solidify
