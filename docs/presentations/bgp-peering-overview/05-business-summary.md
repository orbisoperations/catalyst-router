# Catalyst Node — Operational Briefing

> **CLASSIFICATION**: Internal — Management Eyes Only
> **AUDIENCE**: Executive leadership, program directors, operational managers
> **ANALOGY FRAMEWORK**: Signals intelligence station network

---

## EXECUTIVE SUMMARY

Catalyst Node is an **autonomous signals routing platform**. Each deployed node operates as a **self-sovereign station** — it makes its own decisions, maintains its own intelligence database, and can survive indefinitely if cut off from the network. When stations are connected, they share intelligence automatically through a protocol modeled after how the internet itself routes information (BGP).

**The Catalyst Router (Orchestrator) is the station commander.** It does not handle traffic. It decides where traffic goes.

---

## OPERATIONAL MODEL: Station Network

### Each Station Is an Island

Every Catalyst Node is a **completely independent operating unit**. This is the core design principle — no station depends on a central headquarters. No station needs permission from another station to function.

| Station Component                  | Role                                                                                      | Operational Analogy                                                  |
| ---------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **Orchestrator** (Catalyst Router) | Maintains the intelligence database, coordinates all internal components, decides routing | Station Commander — knows the full picture, issues orders            |
| **Route Table (RIB)**              | The master registry of all known services and how to reach them                           | The station's intelligence ledger — what we know and who told us     |
| **GraphQL Gateway**                | Handles actual data traffic, executes queries                                             | The communications desk — moves the actual signals                   |
| **Auth Service**                   | Manages cryptographic identity, signs tokens, rotates keys                                | The cipher room — controls who can speak on the network              |
| **Journal (SQLite)**               | Persistent action log with snapshot + replay recovery                                     | The station's black box — survives crashes, enables full recovery    |
| **Port Allocator**                 | Assigns network ports for ingress/egress traffic                                          | Radio frequency assignment — each channel gets a dedicated frequency |
| **OTEL Collector**                 | Performance monitoring, tracing, metrics                                                  | Station telemetry and situation awareness feeds                      |

### What "Autonomous" Means in Practice

- **No central controller.** There is no headquarters server. Each station operates independently.
- **No distributed consensus.** Stations don't vote on state. Each station is the sole authority on its own decisions.
- **Crash recovery from local journal.** If a station goes down and restarts, it recovers its full state from its own persistent log. No phone-home required.
- **Graceful degradation.** If a peer connection drops, the station doesn't panic — it marks those routes as "stale" and waits for reconnection. Only after a configurable timeout does it purge them.

---

## INTELLIGENCE SHARING: The iBGP Protocol

Stations share intelligence with each other through a protocol called **iBGP** (internal BGP). This is how the network collectively knows where every service lives.

### The Intelligence Database Has Two Sections

| Section      | Contents                                    | How It Gets There                                     |
| ------------ | ------------------------------------------- | ----------------------------------------------------- |
| **LOCAL**    | Services physically running on this station | Direct registration — we know because it's right here |
| **INTERNAL** | Services running on other stations          | Learned from peers via iBGP — another station told us |

> **V2 Design Decision**: There is no "external" section. The architecture was simplified to just local + internal. Every route is either ours or was shared by a trusted peer.

### How Sharing Works

1. **Connection**: Station A connects to Station B (authenticated, token-based)
2. **Full Sync**: Both stations immediately exchange their complete intelligence — every local route they have
3. **Delta Updates**: From that point on, only changes are shared (new service appeared, service went down)
4. **Keepalive**: Periodic heartbeat confirms the connection is alive (every holdTime/3)
5. **Multi-Hop**: If Station B knows about a service on Station D, it re-advertises that route to Station A with the full path recorded: `[D, B]`

### Path Tracking and Loop Prevention

Every route carries a **nodePath** — the list of stations it has traveled through. This serves two critical functions:

- **Loop detection**: If a station sees its own ID in the path, it discards the route. No circular intelligence.
- **Best-path selection**: If two paths exist to the same service, the shorter path wins.
- **Maximum depth**: 64 hops. This is a hard limit to prevent runaway propagation.

---

## THE CATALYST ROUTER — STATION COMMANDER

The Orchestrator (Catalyst Router) is the decision engine at the center of every station. Here's how it processes every event:

```
    ┌──────────────────────────────────────────────────────────────────┐
    │                    DISPATCH PIPELINE                             │
    │                                                                  │
    │  Action arrives                                                  │
    │      │                                                           │
    │      ▼                                                           │
    │  ┌─────────┐   ┌──────────┐   ┌─────────┐   ┌────────┐        │
    │  │VALIDATE │──▶│  FILTER  │──▶│  PLAN   │──▶│ COMMIT │        │
    │  │         │   │ (Policy) │   │  (RIB)  │   │        │        │
    │  └─────────┘   └──────────┘   └─────────┘   └───┬────┘        │
    │                                                   │             │
    │                              ┌────────────────────┼──────┐      │
    │                              ▼            ▼       ▼      │      │
    │                          Notify       Sync GW   Sync     │      │
    │                          Peers        Config    Envoy    │      │
    │                              └────────────────────────────┘      │
    └──────────────────────────────────────────────────────────────────┘
```

**Key design**: The **Plan** step is a pure calculation — no side effects. It computes what the new state _should_ be. Only after **Commit** do external actions happen. This separation ensures the station never ends up in a half-executed state.

**All actions are serialized** through a single queue. No race conditions. No conflicting updates. One action at a time, fully processed before the next begins.

---

## FAILURE MODES AND RESILIENCE

| Scenario                          | Station Behavior                                                                                                                                                          | Business Impact                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **Peer connection drops**         | Routes from that peer marked "stale" (not deleted). ReconnectManager begins exponential backoff (1s, 2s, 4s... up to 60s). On reconnect: full sync replaces stale routes. | Services remain routable during brief outages. No false withdrawals. |
| **Peer stays down past holdTime** | Stale routes are purged. Withdrawal messages sent to all other peers. Ports released.                                                                                     | Clean removal. No traffic sent to dead stations.                     |
| **Station crashes**               | On restart: SQLite journal replayed. Full state recovered. Peers reconnect automatically.                                                                                 | Recovery without external coordination. Self-healing.                |
| **Routing loop attempted**        | nodePath check immediately discards routes containing our own ID.                                                                                                         | Impossible to create circular routes.                                |
| **Network partition**             | Each partition operates independently with whatever intelligence it last had. On heal: full sync restores consistency.                                                    | Degraded but functional. Eventually consistent.                      |

---

## CAPACITY AND LIMITS

| Parameter                | Limit     | Purpose                          |
| ------------------------ | --------- | -------------------------------- |
| Max updates per message  | 1,000     | Prevents oversized iBGP messages |
| Max hop depth (nodePath) | 64        | Loop protection ceiling          |
| Node ID length           | 253 chars | DNS-compatible identifiers       |
| Tags per service         | 32        | Metadata ceiling                 |
| Endpoint URL length      | 2,048     | Standard URL limit               |

---

## STRATEGIC VALUE

### Why This Architecture

The island model was chosen deliberately. Here's what it buys the organization:

**Operational Independence**

> Deploy a station anywhere — on-prem, cloud, edge, air-gapped. It works the moment it starts. Connect it to peers when ready.

**Zero Single Point of Failure**

> No central database, no master node, no coordination service. If any station dies, every other station continues operating with its last-known intelligence.

**Automatic Service Discovery**

> Deploy a new service on any station. Within seconds, every connected station knows about it and can route traffic to it. No tickets. No configuration changes. No DNS updates.

**Self-Healing Network**

> Connections drop and recover automatically. Routes are propagated, withdrawn, and re-learned without human intervention. The network converges to correct state on its own.

**Audit Trail**

> Every state change is journaled. Every action is logged. Full replay capability from any point in time. The station's black box is always recording.

---

## KEY TAKEAWAY

> **Catalyst Node is a network of autonomous stations. Each station is operationally independent — it maintains its own intelligence, makes its own routing decisions, recovers from its own failures, and shares information with peers only through authenticated, audited channels. The Catalyst Router sits at the center of each station as the sole decision authority. No station trusts another station's judgment — it verifies, filters, and independently decides what intelligence to accept and what to share.**

This is not a centralized system with distributed workers. This is a federation of equals.
