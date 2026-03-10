# @catalyst/routing

Core routing primitives for the Catalyst Router control plane. Provides the BGP-inspired
state machine, schemas, and journal that the orchestrator builds on.

## Exports

The package exposes two entry points:

```ts
import { ... } from '@catalyst/routing/v2' // current (BGP-inspired)
import { ... } from '@catalyst/routing/v1' // legacy action/plugin model
```

### v2 (current)

| Module                                  | Description                                                                                                                   |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **RIB** (`rib/`)                        | Pure-function `plan()` + `commit()` state machine. Accepts actions, returns `{ prevState, newState, routeChanges, portOps }`. |
| **ActionQueue** (`rib/`)                | Serializes async dispatch to guarantee single-writer access to RIB state.                                                     |
| **Journal** (`journal/`)                | Append-only action log with snapshot-based compaction. `InMemoryActionLog` (tests) and `SqliteActionLog` (production).        |
| **Schemas** (`schema.ts`)               | Zod schemas for all v2 action types — local, internal protocol, and system actions.                                           |
| **State** (`state.ts`)                  | `RoutingTable`, `PeerEntry`, `InternalRoute` types and their Zod schemas.                                                     |
| **DataChannel** (`datachannel.ts`)      | Route definition with `routeKey()` helper.                                                                                    |
| **CloseCodes** (`close-codes.ts`)       | Typed close reasons: `NORMAL`, `TRANSPORT_ERROR`, `HOLD_EXPIRED`, `ADMIN_SHUTDOWN`, `PROTOCOL_ERROR`.                         |
| **PortOperation** (`port-operation.ts`) | Declarative `allocate`/`release` port ops for Envoy sidecar integration.                                                      |
| **RoutePolicy** (`route-policy.ts`)     | Pluggable route filtering interface (default: pass-through).                                                                  |

### Action types

Actions are split by origin:

- **Local** (`local/actions.ts`) — `LocalRouteCreate`, `LocalRouteDelete`, `LocalPeerCreate`, `LocalPeerUpdate`, `LocalPeerDelete`
- **Internal** (`internal/actions.ts`) — `InternalProtocolOpen`, `InternalProtocolConnected`, `InternalProtocolUpdate`, `InternalProtocolClose`, `InternalProtocolKeepalive`
- **System** (`system/actions.ts`) — `Tick`

## Key design decisions

1. **`plan()` is pure** — given `(state, action)`, returns new state and side-effect descriptors with no I/O.
2. **`commit()` owns side effects** — journals the action, stamps timestamps, returns the plan for the caller to execute async I/O (peer notifications, port ops).
3. **Path-vector loop detection** — `InternalProtocolUpdate` rejects routes whose `nodePath` contains the local `nodeId`.
4. **Hold timer** — peers negotiate `holdTime = min(local, remote)`. `Tick` actions expire peers that haven't sent a keepalive within `holdTime` ms.
5. **Graceful restart** — `TRANSPORT_ERROR` close marks routes `isStale` instead of removing them, allowing the peer to reconnect and refresh.
6. **Journal compaction** — Snapshot + truncate compaction bounds journal growth. `CompactionManager` periodically snapshots the current `RouteTable`, prunes old entries (retaining a configurable tail), and vacuums SQLite to reclaim disk space. Recovery loads the snapshot first, then replays only the tail.

## Journal compaction

The journal supports snapshot-based compaction to prevent unbounded growth:

```
┌──────────┐   snapshot(seq, state)   ┌──────────┐   prune(seq - tailSize)   ┌──────────┐
│  Journal  │ ───────────────────────► │ Snapshot  │ ───────────────────────► │ Pruned   │
│  (full)   │                          │  written  │                          │ + vacuum │
└──────────┘                           └──────────┘                           └──────────┘
```

**Recovery flow:**

1. `getSnapshot()` → if present, restore state from snapshot
2. `replay(snapshot.atSeq)` → replay only entries after the snapshot
3. Apply each entry via `plan()`/`commit()` on a temporary RIB

**Configuration** (via `OrchestratorConfigSchema.journal`):

| Field                  | Default    | Description                                    |
| ---------------------- | ---------- | ---------------------------------------------- |
| `mode`                 | `"memory"` | `"sqlite"` for persistence, `"memory"` for dev |
| `path`                 | —          | SQLite file path (required for sqlite mode)    |
| `compactionIntervalMs` | `86400000` | Compaction check interval (0 disables)         |
| `minEntries`           | `1000`     | Minimum entries before compaction triggers     |
| `tailSize`             | `100`      | Entries retained after snapshot for debugging  |

## Testing

```bash
pnpm exec vitest run packages/routing/tests/v2/
```

102 unit tests covering RIB, journal, schema, action queue, route policy, and close codes.
See [Test Catalog](../../docs/reference/test-catalog.md) for the full inventory.
