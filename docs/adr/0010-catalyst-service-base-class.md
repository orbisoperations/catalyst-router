# ADR-0010: Unified Service Base Class (CatalystService)

**Status:** Accepted
**Date:** 2026-02-09
**Decision Owner(s):** Engineering Team

## Context

Each service app (auth, gateway, orchestrator, node) independently set up Hono servers, config loading, telemetry, health checks, and signal handlers. This led to inconsistent behavior across the stack.

### Current State

- **Inconsistent telemetry**: Gateway had full OpenTelemetry, auth had LogTape only, orchestrator had nothing.
- **Duplicated boilerplate**: Each app contained 100-150+ lines of server setup (port binding, signal handlers, health endpoints).
- **No in-process composition**: Each service required its own port and process, making it impossible to mount multiple services on a single Hono instance.
- **Inconsistent health checks and shutdown**: Each app implemented its own `/health` response format and shutdown sequence.

### Requirements

| Requirement              | Priority | Notes                                                            |
| ------------------------ | -------- | ---------------------------------------------------------------- |
| Uniform telemetry        | Must     | Every service gets OTel tracing, metrics, and structured logging |
| Reduced boilerplate      | Must     | Server entrypoints should be minimal                             |
| In-process composability | Must     | Mount multiple services on one Hono instance                     |
| Testability via DI       | Should   | Accept pre-built telemetry (noop for tests)                      |
| Consistent lifecycle     | Should   | Standardized init, health, and shutdown across all services      |

## Decision

**Chosen Option: Abstract base class + generic server wrapper**

Introduce a `@catalyst/service` package (`packages/service/`) with two primary exports:

1. **`CatalystService`** -- abstract base class providing config injection, automatic OpenTelemetry setup, and a lifecycle state machine (`created` -> `initializing` -> `ready` -> `shutting_down` -> `stopped`).
2. **`CatalystHonoServer` / `catalystHonoServer()`** -- generic Hono server wrapper that adds telemetry middleware, a standard `/health` endpoint, `Bun.serve()` binding, and graceful shutdown on SIGTERM/SIGINT.

Each service extends `CatalystService`, defines `info` (name, version) and `handler` (a Hono route group), and overrides `onInitialize()` to build domain objects and register routes. Server entrypoints are ~10 lines:

```ts
const auth = await AuthService.create({ config })
catalystHonoServer(auth.handler, { services: [auth], port: config.port }).start()
```

Services can also be composed in-process:

```ts
const app = new Hono()
app.route('/auth', auth.handler)
app.route('/gateway', gateway.handler)
catalystHonoServer(app, { services: [auth, gateway] }).start()
```

### Rationale

1. **Consistency** -- every service gets telemetry, health checks, and graceful shutdown for free by extending the base class.
2. **Composability** -- services expose a `.handler` (Hono route group) that can run standalone or be mounted together on one Hono instance.
3. **Reduced boilerplate** -- server entrypoints went from 100-150 lines to ~10 lines.
4. **Testability** -- services accept pre-built telemetry (including noop) via `CatalystServiceOptions.telemetry`, so the base class skips `TelemetryBuilder.build()` and does not own the telemetry lifecycle.

### Trade-offs Accepted

- **Base class coupling** -- all services depend on `@catalyst/service`. Acceptable because the shared behavior (telemetry, lifecycle) is genuinely universal.
- **Two-phase initialization** -- constructor is synchronous, `initialize()` is async. This requires a factory pattern (`AuthService.create()`) instead of plain `new`. Necessary because telemetry setup is inherently async.
- **Hono coupling** -- the `handler` property is a Hono instance, tying route definition to the Hono framework. Acceptable because Hono is already the chosen HTTP framework across all services.

## Consequences

### Positive

- Uniform OpenTelemetry tracing, metrics, and structured logging across all services.
- In-process composition enables running multiple services on a single port (useful for single-node deployments).
- Server entrypoints are trivial, reducing maintenance burden and onboarding friction.
- Graceful shutdown is consistent: services flush telemetry and clean up in a defined order.

### Negative

- New dependency for all services (`@catalyst/service`).
- Learning curve for the `CatalystService` pattern (lifecycle hooks, factory `create()`).

### Neutral

- Existing `RpcTarget` pattern is preserved -- services wrap RpcTargets in their `onInitialize()`, they do not replace them.
- Telemetry ownership follows a clear rule: if pre-built telemetry is injected, the caller owns shutdown; otherwise the service shuts it down.

## Implementation

- **Package**: `packages/service/` (`@catalyst/service`)
- **Key exports**: `CatalystService`, `CatalystHonoServer`, `catalystHonoServer()`, `ICatalystService`, `ServiceInfo`, `ServiceState`, `CatalystServiceOptions`
- **Migrated services**: auth, gateway, orchestrator, node

### Lifecycle state machine

```
created --> initializing --> ready --> shutting_down --> stopped
```

- `created`: constructor complete, `initialize()` not yet called
- `initializing`: telemetry being built, `onInitialize()` running
- `ready`: service is serving requests
- `shutting_down`: `onShutdown()` running, telemetry flushing
- `stopped`: fully shut down

## Risks and Mitigations

| Risk                                    | Likelihood | Impact | Mitigation                                                                 |
| --------------------------------------- | ---------- | ------ | -------------------------------------------------------------------------- |
| Base class becomes a god object         | Medium     | Medium | Keep it minimal -- only config, telemetry, and lifecycle. No domain logic. |
| Breaking change to base class signature | Low        | High   | Stable `CatalystServiceOptions` interface; additive changes only.          |
| Telemetry build failure blocks startup  | Low        | High   | Fallback to `TelemetryBuilder.noop()` on build error.                      |

## Related Decisions

- [ADR-0001](./0001-unified-opentelemetry-observability.md) - CatalystService auto-configures OpenTelemetry via `TelemetryBuilder`
- [ADR-0006](./0006-node-orchestrator-architecture.md) - CatalystService standardizes the service lifecycle within the pod architecture

## References

- `packages/service/src/catalyst-service.ts` -- base class implementation
- `packages/service/src/catalyst-hono-server.ts` -- server wrapper implementation

---

## Appendix: Options Considered

<details>
<summary>Click to expand full options analysis</summary>

### Option 1: Abstract base class with handler (chosen)

Introduce `CatalystService` abstract class that owns config + telemetry + lifecycle, and expose a `.handler` property (Hono route group) for HTTP binding.

**Approach:**

- Abstract base class provides `config`, `telemetry`, lifecycle state machine
- Subclasses override `onInitialize()` / `onShutdown()` hooks
- `CatalystHonoServer` wraps any Hono handler with standard middleware and shutdown

**Pros:**

- Real shared behavior (telemetry auto-setup, lifecycle guards)
- Composition via Hono route mounting
- Static `create()` factory handles the two-phase init pattern

**Cons:**

- Inheritance coupling -- all services tied to one base class
- Two-phase init adds complexity vs. plain constructors

### Option 2: Interface-only contract

Define an `ICatalystService` interface but provide no base class. Each service implements the interface independently.

**Approach:**

- Define `ICatalystService` with `handler`, `info`, `initialize()`, `shutdown()`
- Each service implements telemetry and lifecycle from scratch

**Pros:**

- No inheritance coupling
- Maximum flexibility per service

**Cons:**

- No shared behavior -- every service reimplements telemetry setup, health checks, shutdown
- Inconsistency is likely to creep back in over time
- More code to maintain across four+ services

### Option 3: No abstraction (status quo)

Keep the existing ad-hoc per-service server setup.

**Approach:**

- Each app owns its full server lifecycle
- Shared patterns copied between apps as needed

**Pros:**

- No new dependency
- Each service is fully self-contained

**Cons:**

- Inconsistent telemetry, health checks, shutdown behavior (the problems motivating this ADR)
- High boilerplate per service
- No path to in-process composition

### Option 4: Framework-agnostic base class

Service base class has no knowledge of Hono. The server entrypoint file handles all HTTP binding.

**Approach:**

- `CatalystService` provides config, telemetry, lifecycle but no `handler` property
- Server files create Hono apps and wire routes from services manually

**Pros:**

- Base class is framework-agnostic
- Could theoretically swap HTTP frameworks

**Cons:**

- Routes like JWKS, health checks are domain logic that belong to the service, not the entrypoint
- More boilerplate in server files
- Framework swap is unrealistic given Hono is deeply integrated

</details>
