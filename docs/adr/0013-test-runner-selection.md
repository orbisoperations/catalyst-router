# ADR-0013: Test Runner Selection (Vitest)

**Status:** Accepted
**Date:** 2026-02-18
**Decision Owner(s):** Engineering Team

## Context

The project is migrating from Bun to Node.js (ADR-0011). Bun ships its own built-in test runner (`bun test`) that is unavailable on Node.js. A replacement must be chosen and applied consistently across the monorepo.

### Current State

The monorepo is in a split state across two test runners:

| Runner                              | Test files | Packages/apps                                                                             |
| ----------------------------------- | ---------- | ----------------------------------------------------------------------------------------- |
| `bun test` (via `bun:test` imports) | 59         | gateway, orchestrator, auth, cli, envoy, authorization, telemetry, types, config, routing |
| Vitest (via `vitest` imports)       | 6          | node-service, sdk, service (partial), auth/container                                      |

**Already on Vitest:** `apps/node`, `packages/sdk`, `packages/service` (tests import from `vitest`), `apps/auth/tests/container.test.ts`

**Still on `bun:test`:** all remaining test files, using `import { describe, it, expect, mock, ... } from 'bun:test'`

**Bun-specific test APIs in use:**

- `Bun.spawn()` / `Bun.spawnSync()` — used in container tests across gateway, orchestrator, auth, cli, envoy, and examples to build Docker images and run subprocesses
- `mock` from `bun:test` — used for function mocking in unit tests

The workspace catalog already pins `vitest` at `^4.0.16` in `package.json`. Both existing `vitest.config.ts` files (`apps/node/`, `packages/sdk/`) follow the same pattern with `environment: 'node'` and `@vitest/coverage-v8`.

### Requirements

| Requirement                         | Priority | Notes                                |
| ----------------------------------- | -------- | ------------------------------------ |
| Works on Node.js                    | Must     | Primary migration requirement        |
| Native TypeScript support           | Must     | No transpile step in test runner     |
| Native ESM support                  | Must     | All packages use `"type": "module"`  |
| Compatible API with `bun:test`      | Must     | Minimize test file rewrites          |
| `vi.fn()` / `vi.mock()` mocking     | Must     | Replaces `mock` from `bun:test`      |
| Fast feedback in watch mode         | Should   | Developer experience                 |
| Coverage reporting                  | Should   | CI quality gates                     |
| Workspace-wide runner               | Should   | Single `vitest` invocation from root |
| No config required for simple cases | Could    | Reduce setup overhead                |

## Decision

**Chosen Option: Vitest**

Adopt Vitest as the standard test runner across all packages and apps in the monorepo, replacing `bun test`. This formalizes and completes a migration that is already partially underway — `apps/node`, `packages/sdk`, and `packages/service` already use Vitest, and `vitest ^4.0.16` is already catalogued in the root workspace.

### Rationale

1. **Already in progress** — The workspace catalog already pins Vitest and three packages already run it. Choosing Vitest completes an in-progress direction rather than introducing a new dependency.

2. **API compatibility with `bun:test`** — Vitest's API (`describe`, `it`, `expect`, `beforeAll`, `afterAll`, `beforeEach`, `afterEach`) is identical to `bun:test`'s exported names. The only change needed is replacing `import { ... } from 'bun:test'` with `import { ... } from 'vitest'`. Test logic is untouched for the vast majority of files.

3. **Native ESM and TypeScript** — Vitest runs TypeScript and ESM natively via Vite's transform pipeline. No `ts-jest`, no `babel`, no separate compile step. This matches how `bun test` handled TypeScript.

4. **`vi` mock API replaces `mock` from `bun:test`** — `mock` in `bun:test` creates a spy/stub function. Vitest's equivalent is `vi.fn()`. Both `vi.spyOn()` and `vi.mock()` provide module-level mocking. The callsites are different but the migration is mechanical.

5. **`@vitest/coverage-v8`** — Coverage is already configured via `@vitest/coverage-v8` in existing `vitest.config.ts` files. This integrates with Node.js V8's built-in coverage engine — no additional tooling needed.

6. **Workspace mode** — Vitest supports a root-level `vitest.workspace.ts` that enumerates all packages, enabling `vitest run` from the repo root to run all tests. This replaces the per-package `bun test` scripts.

### `bun:test` API Migration Map

| `bun:test`                                             | Vitest equivalent                                    | Notes                         |
| ------------------------------------------------------ | ---------------------------------------------------- | ----------------------------- |
| `import { describe, it, expect, ... } from 'bun:test'` | `import { describe, it, expect, ... } from 'vitest'` | Rename import only            |
| `mock(fn)`                                             | `vi.fn()`                                            | Import `vi` from `vitest`     |
| `mock.module(path, factory)`                           | `vi.mock(path, factory)`                             | Module-level mock             |
| `spyOn(obj, method)`                                   | `vi.spyOn(obj, method)`                              | Import `vi` from `vitest`     |
| `afterEach(() => mock.restore())`                      | `afterEach(() => vi.restoreAllMocks())`              | Restore spies after each test |

### Bun Runtime API Migration Map

Container tests use `Bun.spawn` and `Bun.spawnSync` to invoke Docker commands. These must be replaced with Node.js equivalents:

| `bun` API                  | Node.js equivalent                                                | Notes                                                                 |
| -------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------- |
| `Bun.spawnSync(cmd, opts)` | `spawnSync(cmd[0], cmd.slice(1), opts)` from `node:child_process` | Synchronous; `exitCode` → `status`                                    |
| `Bun.spawn(cmd, opts)`     | `spawn(cmd[0], cmd.slice(1), opts)` from `node:child_process`     | Returns `ChildProcess`; use `exited` promise pattern → event listener |
| `proc.exited` (Promise)    | `new Promise(resolve => proc.on('close', resolve))`               | `ChildProcess` uses events, not promises                              |
| `Bun.sleep(ms)`            | `new Promise(resolve => setTimeout(resolve, ms))`                 | Standard timer                                                        |

### Trade-offs Accepted

- **Migration effort for 59 test files** — Every file importing from `bun:test` needs its import updated. The change is mechanical (sed-replaceable for most files), but container tests with `Bun.spawn` require more careful rewrites.
- **`bun:test` mock API differences** — `mock` (bun) vs `vi.fn()` (vitest) have different callsite syntax. Files using `mock` need callsite updates, not just import changes.
- **Vitest startup overhead** — Vitest starts a Vite dev server to handle transforms, which adds ~200-500ms cold-start vs `bun test`'s near-instant startup. Acceptable given the correctness and ecosystem benefits.
- **No `bun:test` type extensions** — `bun:test` extends Jest matchers with a few extra matchers. Any tests relying on Bun-specific matchers will need to find Vitest equivalents or `@vitest/expect-extend`.

## Consequences

### Positive

- Test suite runs on Node.js — unblocks the runtime migration.
- Single test runner across the entire monorepo — eliminates the current split state.
- ESM and TypeScript work without configuration for simple packages.
- `vitest --watch` provides fast incremental feedback during development.
- Coverage via `@vitest/coverage-v8` integrates with existing CI tooling.
- Vitest's in-source testing support (optional) keeps test and implementation co-located.

### Negative

- 59 test files require import line updates (`bun:test` → `vitest`).
- Container tests (~15 files) require `Bun.spawn`/`Bun.spawnSync` → `node:child_process` rewrites.
- `mock` callsites across unit tests require `vi.fn()` / `vi.spyOn()` updates.
- Cold-start time is slightly slower than `bun test`.

### Neutral

- Per-package `vitest.config.ts` files can be minimal (environment + include patterns); the existing configs in `apps/node` and `packages/sdk` serve as the canonical template.
- `bun test` scripts in `package.json` across all packages must be updated to `vitest run` (non-watch) and `vitest` (watch).
- The find-based `test:unit` / `test:integration` split scripts used in many packages can be replaced with Vitest's `include`/`exclude` pattern in config, or kept as `vitest run --reporter=verbose src/**/*.test.ts`.

## Implementation

### Phase 1: Config and catalog

Verify `vitest ^4.0.16` and `@vitest/coverage-v8` are in the workspace catalog (already present). Add a root-level `vitest.workspace.ts`:

```typescript
import { defineWorkspace } from 'vitest/config'

export default defineWorkspace([
  'apps/*/vitest.config.ts',
  'packages/*/vitest.config.ts',
  'examples/*/vitest.config.ts',
])
```

### Phase 2: Per-package `vitest.config.ts`

Add a `vitest.config.ts` to each package that doesn't have one, following the existing template:

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts', 'tests/**/*.{test,spec}.ts'],
    // For container/integration tests, set a longer timeout:
    // testTimeout: 180_000,
  },
})
```

### Phase 3: Import migration (59 files)

Replace `bun:test` imports with `vitest`:

```typescript
// Before
import { describe, it, expect, mock, beforeAll, afterAll } from 'bun:test'

// After
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
```

Replace `mock(fn)` callsites:

```typescript
// Before
const handler = mock(() => Promise.resolve({ status: 200 }))

// After
const handler = vi.fn(() => Promise.resolve({ status: 200 }))
```

### Phase 4: Container test migration (Bun.spawn → child_process)

Replace `Bun.spawnSync` (synchronous subprocess):

```typescript
// Before
const result = Bun.spawnSync(['docker', 'info'])
if (result.exitCode !== 0) {
  /* skip */
}

// After
import { spawnSync } from 'node:child_process'
const result = spawnSync('docker', ['info'])
if (result.status !== 0) {
  /* skip */
}
```

Replace `Bun.spawn` with async `exec` via a promise helper:

```typescript
// Before
const proc = Bun.spawn(['docker', 'build', '-t', imageName, '-f', dockerfile, '.'], {
  cwd: repoRoot,
  stderr: 'inherit',
})
await proc.exited

// After
import { spawn } from 'node:child_process'

function spawnAsync(cmd: string, args: string[], opts: SpawnOptions): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, opts)
    proc.on('close', resolve)
    proc.on('error', reject)
  })
}

await spawnAsync('docker', ['build', '-t', imageName, '-f', dockerfile, '.'], {
  cwd: repoRoot,
  stdio: ['ignore', 'ignore', 'inherit'],
})
```

### Phase 5: Update package.json scripts

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "test:unit": "vitest run --reporter=verbose",
    "test:integration": "vitest run --reporter=verbose"
  }
}
```

Container tests that require opt-in (via `CATALYST_CONTAINER_TESTS_ENABLED`) can continue using the environment variable guard already present in test files.

## Risks and Mitigations

| Risk                                                             | Likelihood | Impact | Mitigation                                                                              |
| ---------------------------------------------------------------- | ---------- | ------ | --------------------------------------------------------------------------------------- |
| Missed `bun:test` import in a test file                          | Medium     | Low    | Grep for `from 'bun:test'` in CI to fail fast                                           |
| `Bun.spawn` call missed in container test                        | Medium     | Medium | Grep for `Bun\.spawn` in CI; container tests gate on `CATALYST_CONTAINER_TESTS_ENABLED` |
| Vitest config `include` pattern misses test files                | Low        | Medium | Run `vitest run --reporter=verbose` once and audit output                               |
| `mock` vs `vi.fn()` callsite mismatch causes silent test failure | Low        | Medium | TypeScript will error on `mock()` calls once `bun:test` import is removed               |
| Vitest version mismatch between packages                         | Low        | Low    | All packages use `catalog:testing` — single source of truth                             |

## Related Decisions

- ADR-0011 — Node.js runtime adoption; the direct motivation for this decision
- [ADR-0005](./0005-docker-as-container-runtime.md) — Docker as container runtime; container tests depend on Docker CLI, not Bun

## References

- [Vitest documentation](https://vitest.dev/)
- [Vitest workspace configuration](https://vitest.dev/guide/workspace)
- [Vitest migration from Jest](https://vitest.dev/guide/migration.html) — largely applicable to `bun:test` migration
- [node:child_process documentation](https://nodejs.org/api/child_process.html)
- [`@vitest/coverage-v8`](https://vitest.dev/guide/coverage.html)

---

## Appendix: Options Considered

<details>
<summary>Click to expand full options analysis</summary>

### Decision Drivers

- **Node.js compatibility** — Must run on Node.js; `bun test` is unavailable
- **API compatibility** — Prefer minimal test file changes; `bun:test` API must map cleanly
- **TypeScript and ESM** — No compilation step in the test runner
- **Ecosystem maturity** — Actively maintained, broad community
- **Monorepo support** — Must work across multiple packages from a single runner

### Option 1: Vitest (chosen)

A Vite-powered test framework with a Jest-compatible API and first-class TypeScript/ESM support.

**Approach:**

- Replace `import { ... } from 'bun:test'` with `import { ... } from 'vitest'`
- Add per-package `vitest.config.ts` with `environment: 'node'`
- Add root `vitest.workspace.ts` for monorepo-wide runs
- Replace `mock()` with `vi.fn()` and `Bun.spawn` with `node:child_process`

**Pros:**

- Already partially adopted — 6 test files and 3 packages use it today
- `vitest ^4.0.16` already in workspace catalog
- API nearly identical to `bun:test` — import change is the majority of migration work
- Native TypeScript and ESM via Vite transform; no Babel or ts-jest
- Excellent watch mode and UI (`vitest --ui`)
- Workspace mode enables running all tests from repo root
- Active development, large community, stable at v4

**Cons:**

- Vite transform adds ~200-500ms cold-start overhead
- Full monorepo test run requires a workspace config
- `mock` callsites need updating to `vi.fn()` — not just an import swap

### Option 2: Jest (with ts-jest or Babel)

The most widely-used JavaScript test runner; extensive ecosystem.

**Approach:**

- Add `jest`, `ts-jest`, `@types/jest` (or `babel-jest` + `@babel/preset-typescript`)
- Configure `jest.config.ts` per package with `extensionsToTreatAsEsm` for ESM
- Replace `bun:test` imports with `@jest/globals` imports

**Pros:**

- Largest community and most documentation of any JS test framework
- Richest mocking ecosystem (`jest.fn()`, `jest.mock()`, `jest.spyOn()`)
- Stable, battle-tested over many years
- Snapshot testing built-in

**Cons:**

- ESM support in Jest is still experimental and historically painful (`--experimental-vm-modules` flag required)
- Requires `ts-jest` or `babel-jest` for TypeScript — adds toolchain complexity that Vitest avoids
- Heavier: more packages to install, more config to maintain
- Jest API differs more from `bun:test` than Vitest does (e.g., `jest.fn()` vs `mock()` — both require callsite changes, but Jest also requires different import patterns)
- The project has already invested in Vitest; switching to Jest would undo that work

**Verdict:** Rejected. ESM friction and toolchain overhead make Jest a worse fit than Vitest for this codebase.

### Option 3: `node:test` (built-in)

Node.js 18+ ships an experimental test runner (`node:test`) that became stable in Node.js 20.

**Approach:**

- Replace `bun:test` imports with `node:test` (`import { describe, it } from 'node:test'`) and `node:assert` for assertions
- No additional npm packages required

**Pros:**

- Zero external dependencies — built into Node.js
- No installation, no version pinning
- Stable in Node.js 20+ LTS

**Cons:**

- API is NOT compatible with `bun:test` — `node:test` uses `assert` for assertions, not `expect`; importing `describe`/`it` from `node:test` works but the assertion style is fundamentally different
- No `expect()` matcher API — would require adding `@vitest/expect` or a separate assertion library to replicate the `expect(x).toBe(y)` style used across all 65 test files
- No built-in mocking — `mock.fn()` in `node:test` exists but has a different API; no module mocking
- No TypeScript support built-in — requires `tsx` or similar loader to run `.ts` files
- No watch mode with HMR
- Minimal coverage tooling — requires `--experimental-test-coverage` flag

**Verdict:** Rejected. The assertion API incompatibility alone would require rewriting the body of every test, not just the imports. The cost is disproportionate given Vitest is already adopted.

### Option 4: uvu / tap / ava (lightweight runners)

Various lightweight alternatives to Jest/Vitest.

**Approach:**

- Use a minimal runner like `uvu` (fast, tiny) or `tap` (TAP output)

**Pros:**

- Very fast startup
- Minimal dependencies

**Cons:**

- No API compatibility with `bun:test` — full test rewrites required
- No watch mode, coverage, or workspace support comparable to Vitest
- Smaller communities; less documentation
- None of these are already in the project

**Verdict:** Rejected. No meaningful advantage over Vitest; all require more migration work.

</details>
