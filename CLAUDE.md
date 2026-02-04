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

### Understanding the Stack

```bash
gt log short          # View current stack structure
gt stack              # See all branches in your stack
gt branch info        # Info about current branch
```

### Common Workflow

```bash
gt create -m "feat: add feature"   # Create new stacked branch
gt modify -m "update message"      # Amend current branch
gt submit                          # Push stack to GitHub
gt sync                            # Sync with trunk and restack
```

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
