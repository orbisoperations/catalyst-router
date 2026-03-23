# Testing

The canonical classification and migration plan now live in `docs/test-classification-unified.md`.

## Test Tiers

| Tier        | File pattern                      | What it covers                                                                                  | Script                  |
| ----------- | --------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------- |
| Unit        | `*.unit.test.ts`                  | In-process logic, mocks, in-memory state, no real OS resources                                  | `pnpm test:unit`        |
| Integration | `*.integration.test.ts`           | Real localhost ports, filesystem, subprocesses, or other local-machine resources without Docker | `pnpm test:integration` |
| Container   | `*.container.test.ts`             | Docker/Testcontainers, image builds, container networking                                       | `pnpm test:container`   |
| Browser E2E | `apps/web-ui/tests/e2e/*.spec.ts` | Playwright browser flows                                                                        | `pnpm test:e2e`         |

## Running Tests

```bash
# Fast default lanes
pnpm test

# Unit only
pnpm test:unit

# Local-resource integration only
pnpm test:integration

# Docker-backed tests
pnpm test:container

# Browser tests
pnpm test:e2e
```

Package-local wrappers use the same suffix-based filters, so `cd apps/auth && pnpm test:integration` matches the root lane semantics.

## How Test Separation Works

Lane discovery is now filename-driven and explicit:

- `test:unit` runs `unit.test.ts`
- `test:integration` runs `integration.test.ts`
- `test:container` runs `container.test.ts`
- Playwright stays outside Vitest under `apps/web-ui/tests/e2e/*.spec.ts`

The root commands are the source of truth. Integration and container lanes run serially with longer Vitest timeouts because they start real services and, in the container lane, may build Docker images.

Directory names are not lane selectors. Avoid semantic folders named `integration`, `container`, or `e2e` unless the tests inside actually belong to that execution lane. Use neutral names like `scenarios`, `robustness`, or `security` for topical grouping.

## Container Tests

Container tests use [testcontainers](https://node.testcontainers.org/) and require a working Docker daemon.

- Many container suites use `describe.skipIf(...)` when Docker is unavailable, so discovery may differ from runnable test count on machines without Docker.
- Container lanes use extended test and hook timeouts because image builds and startup can take several minutes.
