# OTel Attribute Naming Alignment

## Context

PR review feedback identified that our custom WideEvent attributes don't follow OTel semantic convention naming. OTel requires custom attributes use a domain-specific namespace prefix to avoid collisions with standard semconv attributes.

## Decision

All custom attributes follow the pattern: `catalyst.<component>.<property>`

- `catalyst` — product namespace (matches `@catalyst/*` package naming)
- `<component>` — the service emitting the attribute (e.g. `orchestrator`, `gateway`)
- `<property>` — dot-delimited property path, snake_case for multi-word segments

Standard OTel attributes (`exception.*`, `http.*`, `url.*`, `event.name`) remain unchanged.

## Attribute Mapping

### WideEvent Core (`packages/telemetry`)

| Before              | After                        |
| ------------------- | ---------------------------- |
| `event.outcome`     | `catalyst.event.outcome`     |
| `event.duration_ms` | `catalyst.event.duration_ms` |

### Orchestrator (`apps/orchestrator`)

| Before                 | After                                        |
| ---------------------- | -------------------------------------------- |
| `action.type`          | `catalyst.orchestrator.action.type`          |
| `action.state_changed` | `catalyst.orchestrator.action.state_changed` |
| `peer.name`            | `catalyst.orchestrator.peer.name`            |
| `peer.endpoint`        | `catalyst.orchestrator.peer.endpoint`        |
| `peer.connected_count` | `catalyst.orchestrator.peer.connected_count` |
| `route.change_count`   | `catalyst.orchestrator.route.change_count`   |
| `route.total`          | `catalyst.orchestrator.route.total`          |
| `route.added`          | `catalyst.orchestrator.route.added`          |
| `route.removed`        | `catalyst.orchestrator.route.removed`        |
| `route.modified`       | `catalyst.orchestrator.route.modified`       |
| `route.trigger`        | `catalyst.orchestrator.route.trigger`        |
| `sync.type`            | `catalyst.orchestrator.sync.type`            |
| `reconnect.attempt`    | `catalyst.orchestrator.reconnect.attempt`    |
| `reconnect.delay_ms`   | `catalyst.orchestrator.reconnect.delay_ms`   |
| `node.name`            | `catalyst.orchestrator.node.name`            |

### Unchanged (Standard OTel)

- `event.name`, `exception.type`, `exception.message`, `exception.stacktrace`
- `http.request.method`, `http.response.status_code`, `url.path`

## Files Affected

1. `packages/telemetry/src/wide-event.ts`
2. `packages/telemetry/src/middleware/wide-event.ts`
3. `apps/orchestrator/src/v2/bus.ts`
4. `apps/orchestrator/src/v2/ws-transport.ts`
5. `apps/orchestrator/src/v2/reconnect.ts`
6. `apps/orchestrator/src/v1/orchestrator.ts`

## Convention for Future Services

Any new service adding custom attributes must follow `catalyst.<service>.<property>`. Examples:

- Gateway: `catalyst.gateway.upstream.host`
- Node: `catalyst.node.stream.protocol`
