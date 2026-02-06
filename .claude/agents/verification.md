# Verification Agent

## Description

Run the full verification chain after implementation. Executes lint, format, typecheck, and tests in sequence, stopping on first failure with clear reporting.

## Agent Type

Bash

## When to Use

- After completing implementation
- Before committing changes
- When CI fails and you need to reproduce locally

## Prompt

```
Run the verification chain for changes in: [PACKAGES]

Execute in this order, stopping on first failure:

1. Lint Check
   bun run lint

2. Format Check
   bun run format:check

3. Type Check
   tsc --noEmit

4. Unit Tests (parallel across packages is OK)
   bun test [package1]
   bun test [package2]
   ...

5. Integration Tests (if cross-package changes)
   bun test --grep "integration" [packages]

6. Container Tests (if RPC/networking changes)
   CATALYST_CONTAINER_TESTS_ENABLED=true bun test [packages]

7. Topology Tests (if orchestrator/peering changes)
   bun test --grep "topology" packages/orchestrator

For each step, report:
- ✅ Passed: [step name]
- ❌ Failed: [step name]
  - Package: [affected package]
  - File: [file path and line number]
  - Error: [actual error message]
  - Suggestion: [fix if obvious]

Aggregate all failures at the end with clear formatting.
```

## Example Usage

**Prompt:**

```
Run the verification chain for @catalyst/auth and @catalyst/gateway.
I modified token signing logic and gateway's token verification.
```

**Expected Output:**

```
Verification Chain Results
==========================

✅ Lint: passed (0 errors, 0 warnings)
✅ Format: passed
✅ TypeScript: passed (no type errors)

Running unit tests in parallel...

@catalyst/auth:
❌ 1 failure
   File: packages/auth/tests/sign-token.test.ts:47
   Test: "should include cnf claim in token"
   Error: Expected token payload to have property 'cnf'
   Suggestion: Add cnf claim generation in signToken() per ADR-0007

@catalyst/gateway:
✅ All 12 tests passed

Summary
-------
Steps passed: 3/4
Test failures: 1

Next Steps:
1. Fix cnf claim handling in packages/auth/src/jwt.ts
2. Re-run: bun test packages/auth
```
