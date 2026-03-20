# Fix: Gateway integration.graphql.test.ts

## Problem

`apps/gateway/tests/integration.graphql.test.ts` fails under Vitest with:

```text
Cannot use GraphQLObjectType "Book" from another module or realm.
```

The failure happens when the test calls `gatewayServer.reload()` and the gateway reaches `stitchSchemas()`.

## Actual Root Cause

This is a **Vitest in-process module realm issue**, not a pnpm dedupe problem and not a Docker container problem.

- The gateway and subgraph stitching flow succeeds in a plain Node process against the same books and movies containers.
- The failure only reproduces when the gateway GraphQL stack runs inside Vitest.
- `pnpm why graphql` shows a single `graphql@16.12.0`, so the error is not caused by multiple installed versions.
- `schemaFromExecutor()` is not a fix here because the installed `@graphql-tools/wrap` implementation still uses `buildClientSchema()` internally.

In practice, Vitest ends up mixing GraphQL classes across module realms during the in-process test path, and `stitchSchemas()` rejects the resulting types.

## Real Fix

Do not run the gateway GraphQL stitching pipeline in-process inside Vitest.

Instead:

1. Start the gateway as a **real child process** from the test.
2. Let that child process boot the normal gateway service stack.
3. Configure the gateway over its existing `/api` RPC endpoint.
4. Query the gateway over HTTP at `/graphql`.

This keeps the gateway in a single runtime/module realm and matches production behavior more closely.

## Implementation

- Added `apps/gateway/tests/helpers/gateway-process.ts` to start a real gateway server on an ephemeral port and print the selected port.
- Updated `apps/gateway/tests/integration.graphql.test.ts` to:
  - skip cleanly when Docker is unavailable,
  - start books and movies in Docker containers,
  - spawn the gateway helper process,
  - push dynamic service config via RPC,
  - query the gateway over HTTP,
  - shut the gateway process down after the test.

## Why Not Other Options

- **pnpm override / dedupe**: not applicable; only one installed `graphql` version is present.
- **`schemaFromExecutor()`**: not helpful; it still reconstructs the schema with `buildClientSchema()`.
- **Remove `validateServiceSdl()`**: unrelated; validation succeeds before the failure site.

## Scope

This is a test harness issue specific to the Vitest in-process execution path. Production gateway behavior is not affected.
