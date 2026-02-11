# ADR-0006: Node Orchestrator Architecture

**Status:** Accepted
**Date:** 2026-01-29
**Decision Owner(s):** Engineering Team

## Context

The Catalyst Router Orchestrator is the central control plane component responsible for BGP peering, route management, and sidecar configuration (Envoy, GraphQL Gateway, Auth Service). As the system scales, we need a clear architectural definition of how management operations are handled and how state evolves in response to events.

### Current State

The `Orchestrator` class currently handles a variety of responsibilities, including:

- Providing management APIs for network and data channel configuration.
- Maintaining the global route table state.
- Propagating route updates to BGP peers.
- Syncing configuration to local sidecar services.

### Requirements

| Requirement              | Priority | Notes                                                     |
| ------------------------ | -------- | --------------------------------------------------------- |
| Unified State Management | Must     | Centralized, predictable state updates.                   |
| Side Effect Isolation    | Must     | Separation of state mutation from network/IO operations.  |
| Role-Based Access        | Must     | Granular permissions for different management operations. |
| Extensibility            | Should   | Easy to add new protocols or management clients.          |

## Decision

**Chosen Option: Split Management Plane and Action/Notify Pipeline**

We define the Orchestrator as a functional state machine driven by an event pipeline split into two distinct phases: **Action** (Synchronous State Mutation) and **Notify** (Asynchronous Side Effects). Management operations are exposed via specialized client interfaces.

### Management Plane Components

The Orchestrator exposes its management surface throughthree primary client interfaces, each designed for a specific administrative role:

1.  **NetworkClient**: Manages BGP peerings (add, update, remove peers). Targeted at `networkcustodian` roles.
2.  **DataChannelClient**: Manages local data channel definitions and views the unified route table (local + internal). Targeted at `datacustodian` roles.
3.  **IBGPClient**: Handles the low-level BGP protocol handshake and route updates between nodes.

These clients are thin wrappers around the central `dispatch` method, ensuring all management inputs flow through the same pipeline.

### Orchestrator Event Pipeline: Action vs. Notify

The core logic of the Orchestrator is split into two phases to ensure state consistency and avoid deadlocks:

#### 1. Phase 1: Action (`handleAction`)

- **Responsibility**: pure state mutation.
- **Characteristics**: Synchronous, deterministic, and isolated.
- **Logic**: Takes the current `state` and an `action`, applies permissions, and returns a new `state` delta. It **MUST NOT** perform any network IO or side effects.
- **Example**: Creating a local route adds an entry to the `state.local.routes` array.

#### 2. Phase 2: Notify (`handleNotify`)

- **Responsibility**: Side effects and propagation.
- **Characteristics**: Asynchronous, "fire and forget" (non-blocking).
- **Logic**: Evaluates the `newState` vs. `prevState` and triggers external actions.
- **Examples**:
  - Broadcasting a new local route to all connected BGP peers.
  - Syncing the updated route table to the GraphQL Gateway sidecar via RPC.
  - Initiating a connection to a newly added peer.

### Rationale

1.  **State Integrity** — By forcing all mutations through `handleAction`, we ensure that the system state is always consistent and reflects the results of validated actions.
2.  **Deadlock Prevention** — Separating side effects (which may involve RPC calls back to the same node or other peers) into the `Notify` phase prevents blocking the main event loop.
3.  **Scalability** — The pipeline pattern allows for easy addition of new plugins or handlers without bloating the core dispatch logic.

### Trade-offs Accepted

- **Eventual Consistency** — Side effects in `Notify` happen after the state is committed. If a notification fails, the state on the local node might differ from the state of the network/sidecars until the next sync or retry.

## Consequences

### Positive

- Clear separation of concerns between state management and communication.
- Improved testability: `handleAction` can be unit tested with pure state transitions.
- Granular security: Role-based access control is enforced at the entry point of the pipeline.

### Negative

- Increased complexity in tracing a single operation from input through its resulting side effects.

## Implementation

The implementation is centered in `apps/orchestrator/src/orchestrator.ts`:

- `dispatch()`: Entry point that coordinates `handleAction` followed by `handleNotify`.
- `handleAction()`: Contains the switch/case for all state transitions.
- `handleNotify()`: Orchestrates side effects like `handleBGPNotify()` and `handleGraphqlConfiguration()`.

## Related Decisions

- [ADR-0005](./0005-docker-as-container-runtime.md) - Context for sidecar management.

## References

- [Architecture](../architecture/overview.md) - High-level system overview.
