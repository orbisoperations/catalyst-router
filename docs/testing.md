# Testing

## Test Tiers

| Tier        | File pattern            | What it covers                       | Script                  |
| ----------- | ----------------------- | ------------------------------------ | ----------------------- |
| Unit        | `*.test.ts`             | Core logic, no external dependencies | `pnpm test:unit`        |
| Integration | `*.integration.test.ts` | Cross-package boundaries             | `pnpm test:integration` |
| Topology    | `*.topology.test.ts`    | Orchestrator and peering flows       | `pnpm test:integration` |
| Container   | `*.container.test.ts`   | End-to-end Docker-based validation   | `pnpm test:integration` |

## Running Tests

```bash
# Unit tests only (fast, no Docker)
pnpm test:unit

# Container / integration tests (requires Docker)
pnpm test:integration

# Single package
cd apps/auth && pnpm test:unit
```

## How Test Separation Works

Tests are separated at the **script level**, not with runtime environment variables.

- `test:unit` excludes files matching `*{integration,container}*` via vitest's `--exclude` flag
- `test:integration` includes only files in `container` and `integration` directories

This means container tests are never loaded during `pnpm test:unit` — no env var guards needed in test files.

CI runs these as separate jobs: the `test-unit` job runs `turbo run test:unit`, and the `test-container` job runs `turbo run test:integration`.

## Container Tests

Container tests use [testcontainers](https://node.testcontainers.org/) to spin up Docker containers for integration testing.

**Prerequisites:** A running Docker daemon. The cli container tests check for this automatically via `isDockerRunning()` and skip gracefully if Docker is unavailable.

**Timeouts:** Container tests set long timeouts (3-10 minutes) because they build Docker images. If a container test times out locally, check that Docker has enough resources allocated.
