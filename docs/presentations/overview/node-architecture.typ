// ── packages ──────────────────────────────────────────────
#import "@preview/codly:1.3.0": *
#show: codly-init.with()

// ── document metadata ─────────────────────────────────────
#set document(
  title: "Catalyst Node — Architecture Overview",
  author: "Catalyst Team",
)

// ── page defaults ─────────────────────────────────────────
#set page(
  paper: "us-letter",
  margin: (top: 2.5cm, bottom: 2.5cm, x: 2.2cm),
)
#set text(font: "Libertinus Serif", size: 11pt)
#set par(justify: true, leading: 0.65em)
#set heading(numbering: "1.")

// ── code listing colors ───────────────────────────────────
#codly(
  languages: (
    typescript: (name: "TypeScript", color: rgb("#3178C6")),
    json: (name: "JSON", color: rgb("#F59E0B")),
    bash: (name: "Shell", color: rgb("#10B981")),
  ),
)

// ── heading styles ────────────────────────────────────────
#show heading.where(level: 1): it => {
  v(1.5em)
  line(length: 100%, stroke: 0.4pt + rgb("#2563EB"))
  v(0.25em)
  text(size: 15pt, fill: rgb("#1E3A5F"), weight: "bold")[#it.body]
  v(0.5em)
}

#show heading.where(level: 2): it => {
  v(1em)
  text(size: 12pt, fill: rgb("#1E3A5F"), weight: "bold")[#it.body]
  v(0.25em)
}

#show heading.where(level: 3): it => {
  v(0.8em)
  text(size: 11pt, fill: rgb("#374151"), weight: "bold")[#it.body]
  v(0.2em)
}

// ── title page ────────────────────────────────────────────
#set page(numbering: none, header: none)

#align(center + horizon)[
  #text(size: 30pt, weight: "bold", fill: rgb("#1E3A5F"))[Catalyst Node]
  #v(0.5em)
  #text(size: 18pt, fill: rgb("#64748B"))[Architecture Overview]
  #v(2em)
  #line(length: 40%, stroke: 0.5pt + rgb("#2563EB"))
  #v(2em)
  #text(size: 11pt)[Version 1.0]
  #linebreak()
  #text(size: 11pt, fill: gray)[March 2026]
]

#pagebreak()

// ── running header ────────────────────────────────────────
#set page(
  numbering: "1",
  header: context {
    if counter(page).get().first() > 1 [
      #text(size: 9pt, fill: gray)[_Catalyst Node — Architecture Overview_]
      #h(1fr)
      #text(size: 9pt, fill: gray)[#counter(page).display()]
    ]
  },
  footer: none,
)
#counter(page).update(1)

// ── executive summary ─────────────────────────────────────
#align(center)[#text(weight: "bold", size: 12pt)[Executive Summary]]
#v(0.5em)
#pad(x: 1.5cm)[
  Catalyst Node is a decentralized service mesh that replaces centralized API
  gateways with peer-to-peer service routing. Drawing on the Border Gateway
  Protocol (BGP), it propagates service availability across organizational
  boundaries using a path-vector routing model adapted for logical service
  domains rather than IP prefixes.

  Each node runs as a self-contained _Core Pod_ comprising an orchestrator
  (control plane), an Envoy proxy (data plane), a GraphQL federation gateway,
  an authentication sidecar, and an OpenTelemetry collector. Nodes within the
  same organization peer via internal BGP (iBGP) sessions over Cap'n Proto RPC,
  while cross-organization peering (eBGP) enables controlled service sharing
  between distinct administrative domains.

  This document describes the architecture of a single Catalyst Node, the
  routing protocol that connects nodes into a mesh, the security model that
  protects it, and the operational considerations for deployment.
]
#v(1.5em)

// ── table of contents ─────────────────────────────────────
#outline(title: [Table of Contents], depth: 3, indent: auto)
#pagebreak()

// ══════════════════════════════════════════════════════════
= Introduction
// ══════════════════════════════════════════════════════════

== Problem Statement

Modern distributed systems increasingly span multiple clouds, edge locations,
and organizational boundaries. Traditional service meshes assume a single
administrative domain with centralized control — a sidecar injector, a central
control plane, a single certificate authority. This assumption breaks down
when organizations need to _selectively share_ services with partners while
retaining independent infrastructure and security posture.

Catalyst Node addresses this gap by treating each deployment as an autonomous
system that advertises services to peers, negotiates trust per-session, and
routes traffic through a declarative data plane — without requiring a
centralized coordinator.

== Design Goals

+ *Decentralized routing* — no single point of failure or control for service
  discovery. Each node independently computes its routing table from peer
  advertisements.
+ *Defense-in-depth security* — mutual TLS at the transport layer,
  certificate-bound JWTs at the application layer, and Cedar policy
  authorization at the operation layer.
+ *Separation of planes* — the control plane (orchestrator) decides _what_
  should happen; the data plane (Envoy) executes _how_ traffic flows.
+ *Operational simplicity* — a single Core Pod contains all components. No
  external dependencies beyond peer connectivity.
+ *Protocol familiarity* — BGP's decades of proven convergence properties
  adapted for service routing, giving operators a well-understood mental model.

== Non-Goals

- Full BGP-4 compliance (RFC 4271). Catalyst adapts BGP concepts but does not
  implement the wire protocol.
- Sidecar injection or automatic workload discovery. Services explicitly
  register with their local orchestrator.
- Multi-tenancy within a single node. Each node belongs to one organization.

== Document Organization

@architecture introduces the Core Pod and its components.
@protocol details the peer session protocol and message types.
@routing describes the Routing Information Base and route propagation.
@dataplane covers Envoy integration and traffic forwarding.
@security presents the trust model and authorization framework.
@operations discusses deployment, observability, and failure handling.
@future outlines planned enhancements.

// ══════════════════════════════════════════════════════════
= Architecture Overview <architecture>
// ══════════════════════════════════════════════════════════

== Control Plane and Data Plane

Catalyst Node follows the control-plane / data-plane split common to modern
networking systems. The *control plane* — the orchestrator and its sidecars —
computes routing decisions, manages peer sessions, evaluates authorization
policy, and distributes configuration. The *data plane* — Envoy — forwards
traffic according to the control plane's instructions, enforces mTLS, and
reports telemetry.

This separation ensures that routing logic can be tested, replayed, and
reasoned about independently of network I/O.

== The Core Pod <core-pod>

A Catalyst Node runs as a _Core Pod_: a co-located set of processes that
collectively provide the node's capabilities.

#figure(
  table(
    columns: (auto, auto, 1fr),
    table.header([*Component*], [*Role*], [*Description*]),
    [Orchestrator], [Control plane],
      [BGP-inspired routing engine, peer session manager, xDS server.
       Entry point for all service registration and route propagation.],
    [Envoy Proxy], [Data plane],
      [High-performance L4/L7 proxy configured via xDS. Handles ingress,
       egress, and inter-node traffic with mTLS.],
    [GraphQL Gateway], [Federation],
      [Stitches upstream GraphQL services into a unified supergraph.
       Hot-reloads schema on route table changes.],
    [Auth Service], [Identity],
      [ECDSA key management, JWT issuance and verification, JWKS
       distribution. Provides certificate-bound tokens for peer auth.],
    [OTEL Collector], [Observability],
      [Receives traces, metrics, and logs from all components via OTLP.
       Exports to Prometheus, Jaeger, or InfluxDB.],
  ),
  caption: [Core Pod components and their roles.],
) <tab-components>

All intra-pod communication uses Cap'n Proto RPC over WebSocket (`capnweb`),
providing compact binary serialization with pipelined method calls.

== Node Topology

Nodes connect in three deployment patterns:

- *Single node* — standalone gateway with local services. No peering.
- *Internal mesh (iBGP)* — multiple nodes within the same organization share
  routes via internal peering sessions.
- *Federated mesh (eBGP)* — nodes from different organizations selectively
  share exported services via external peering.

Each pattern is additive: a node that starts standalone can later join an
internal mesh, which can later federate with external peers, without
architectural changes.

// ══════════════════════════════════════════════════════════
= Peer Session Protocol <protocol>
// ══════════════════════════════════════════════════════════

Catalyst's peering protocol adapts BGP session semantics for service discovery.
Peers communicate over persistent WebSocket connections using Cap'n Proto RPC.

== Session Lifecycle

A peer session progresses through the following states:

#figure(
  table(
    columns: (auto, 1fr),
    table.header([*State*], [*Description*]),
    [Initializing], [Peer configured but no connection attempted.],
    [Connecting], [Outbound WebSocket dial in progress.],
    [Connected], [WebSocket established; OPEN message exchanged.],
    [Established], [Hold timer negotiated; route exchange active.],
    [Closed], [Session terminated (normal, error, or admin shutdown).],
  ),
  caption: [Peer session states.],
) <tab-session-states>

The transition from _Connected_ to _Established_ includes hold timer
negotiation: both sides propose a hold time in the OPEN message, and the
session uses the minimum of the two values. This mirrors BGP's hold timer
negotiation (RFC 4271 §4.2).

== Message Types

#figure(
  table(
    columns: (auto, auto, 1fr),
    table.header([*Message*], [*BGP Analog*], [*Purpose*]),
    [`InternalProtocolOpen`], [OPEN],
      [Initiates session. Carries proposed hold time and peer identity.],
    [`InternalProtocolUpdate`], [UPDATE],
      [Advertises or withdraws routes. Contains an array of
       `{ action, route, nodePath, originNode }` entries.],
    [`InternalProtocolKeepalive`], [KEEPALIVE],
      [Resets the remote peer's hold timer. Dispatched periodically
       by the `TickManager`.],
    [`InternalProtocolClose`], [NOTIFICATION],
      [Terminates the session with a typed close code:
       `NORMAL`, `TRANSPORT_ERROR`, `HOLD_EXPIRED`, `ADMIN_SHUTDOWN`,
       or `PROTOCOL_ERROR`.],
  ),
  caption: [Protocol message types and their BGP analogs.],
) <tab-messages>

== Hold Timer and Keepalive

The hold timer prevents zombie sessions. After negotiation, each side must
receive a message (keepalive or update) within the hold time or the session
is expired. The orchestrator's `TickManager` dispatches periodic `Tick`
actions that:

+ Send keepalive messages to all connected peers.
+ Check each peer's `lastReceived` timestamp against the negotiated hold time.
+ Expire peers that have exceeded their hold timer, removing their routes and
  generating port release operations for the Envoy data plane.

A hold time of zero disables expiry checking, which is useful for testing.

== Graceful Restart

When a peer disconnects due to a transport error (as opposed to a clean
shutdown), its routes are marked `isStale` rather than immediately removed.
This allows the peer to reconnect and refresh its routes without causing
a routing flap. Stale routes are cleaned up if the peer fails to reconnect
within its hold timer period.

The `ReconnectManager` handles automatic reconnection with exponential
backoff and configurable jitter.

// ══════════════════════════════════════════════════════════
= Routing and Route Propagation <routing>
// ══════════════════════════════════════════════════════════

== Routing Information Base (RIB)

The RIB is the core state machine of the routing system. It is implemented
as a pure function:

```typescript
function plan(
  state: RoutingTable,
  action: Action,
  nodeId: string,
): PlanResult {
  // Returns { prevState, newState, routeChanges, portOps }
  // No side effects — deterministic and testable
}
```

The `plan()` function accepts the current routing table and an action, and
returns a new state along with descriptors for any side effects (route
changes to propagate, ports to allocate or release). A separate `commit()`
function applies the plan: it updates the internal state, journals the action
to an append-only log, and returns the plan for the caller to execute
asynchronous I/O.

This separation — pure computation in `plan()`, side effects in `commit()`,
async I/O in `handlePostCommit()` — enables deterministic replay, testing
without mocks, and audit logging of every state transition.

== Action Types

Actions are categorized by origin:

#figure(
  table(
    columns: (auto, 1fr),
    table.header([*Category*], [*Actions*]),
    [Local],
      [`LocalRouteCreate`, `LocalRouteDelete`, `LocalPeerCreate`,
       `LocalPeerUpdate`, `LocalPeerDelete`],
    [Internal Protocol],
      [`InternalProtocolOpen`, `InternalProtocolConnected`,
       `InternalProtocolUpdate`, `InternalProtocolClose`,
       `InternalProtocolKeepalive`],
    [System],
      [`Tick` — periodic timer for keepalive and hold timer expiry],
  ),
  caption: [Action types by origin.],
) <tab-actions>

All actions flow through the `OrchestratorBus`, which serializes dispatch
via an `ActionQueue` to guarantee single-writer access to the RIB state.

== Route Advertisement and Withdrawal

When a service registers locally, the orchestrator dispatches a
`LocalRouteCreate` action. The RIB installs the route and emits a route
change. The post-commit handler then advertises the route to all connected
peers by sending an `InternalProtocolUpdate` with `action: "add"`.

Route withdrawal follows the same path: `LocalRouteDelete` removes the
route from the RIB, and the post-commit handler sends `action: "remove"`
to peers.

== Best-Path Selection

When the same service is reachable via multiple peers (e.g., in a
three-node chain A–B–C where both B and C advertise a service originally
from C), the RIB selects the route with the shortest `nodePath`. This
mirrors BGP's preference for shorter AS_PATH lengths.

If a route arrives with a shorter path than the currently installed route
for the same `(name, originNode)` pair, it replaces the existing entry.
Routes with longer paths are silently discarded.

== Loop Detection

Each route carries a `nodePath` — an ordered list of node identifiers
through which the advertisement has passed. Before installing a route,
the RIB checks whether the local `nodeId` appears in the `nodePath`. If
it does, the route is rejected as a loop. This is the path-vector
equivalent of BGP's AS_PATH loop detection.

== Split-Horizon

The post-commit handler never sends a route advertisement back to the
peer from which it was received. This split-horizon rule prevents
immediate routing loops in fully connected topologies.

== Journal and Replay

Every state-changing action is appended to an `ActionLog` — either
`InMemoryActionLog` for testing or `SqliteActionLog` for production. The
journal supports:

- *Full replay*: rebuild routing state from an empty table by replaying
  all journaled actions. Used for crash recovery.
- *Partial replay*: replay actions after a given sequence number. Used
  for incremental state sync.

The journal guarantees that replayed state matches live dispatch state,
serving as both an audit trail and a recovery mechanism.

// ══════════════════════════════════════════════════════════
= Envoy Integration <dataplane>
// ══════════════════════════════════════════════════════════

== xDS Configuration Model

The orchestrator acts as an xDS control plane, serving configuration to
Envoy via REST-based State of the World (SotW) protocol. It manages four
xDS resource types:

#figure(
  table(
    columns: (auto, auto, 1fr),
    table.header([*xDS Type*], [*Envoy Resource*], [*Catalyst Mapping*]),
    [LDS], [Listeners],
      [One ingress listener (port 80) plus dynamic egress listeners per
       remote service.],
    [CDS], [Clusters],
      [One cluster per reachable service, pointing to the peer's Envoy
       egress address.],
    [RDS], [Routes],
      [HTTP route tables mapping service names to clusters.],
    [EDS], [Endpoints],
      [Endpoint addresses for each cluster.],
  ),
  caption: [xDS resource type mapping.],
) <tab-xds>

== Port Allocation

When the RIB installs a route from a remote peer, it may emit a
`PortOperation` with type `allocate`, requesting a local egress port for
Envoy. The port is assigned from a configurable range and used to create
an Envoy listener that forwards traffic to the peer.

When a route is withdrawn or a peer disconnects, the RIB emits a `release`
operation, and the port is returned to the pool. This declarative model —
the RIB describes _what_ ports are needed, the post-commit handler
_executes_ the allocation — keeps the RIB pure and testable.

== Cross-Node Traffic Flow

For a request from Service A on Node 1 to Service B on Node 2:

+ Service A sends the request to `localhost:<egressPort>` (the Envoy
  egress listener allocated for Service B).
+ Envoy on Node 1 forwards the request to Node 2's Envoy ingress
  address.
+ Envoy on Node 2 routes the request to Service B's local endpoint.

All inter-node traffic transits Envoy, enabling uniform mTLS enforcement,
traffic metrics, and rate limiting without application changes.

// ══════════════════════════════════════════════════════════
= Security Model <security>
// ══════════════════════════════════════════════════════════

Catalyst employs a defense-in-depth strategy with three independent
security layers.

== Transport Security (Layer 1)

All inter-node communication requires mutual TLS 1.3. Both peers present
certificates signed by a trusted certificate authority. The TLS handshake
authenticates the transport before any application data is exchanged.

== Application Security (Layer 2)

On top of mTLS, peer sessions authenticate via *certificate-bound JWTs*.
The JWT includes a `cnf.x5t#S256` claim — the SHA-256 thumbprint of the
client's TLS certificate. The server verifies that the TLS certificate
presented during the handshake matches the thumbprint in the JWT. This
binding ensures that a stolen token is useless without the corresponding
private key.

The Auth Service manages the full JWT lifecycle:

- *Key generation*: ECDSA (ES384) key pairs generated in-memory.
- *Token signing*: JWTs signed with the node's private key.
- *JWKS distribution*: Public keys exposed at `/.well-known/jwks.json`
  for peer verification.
- *Key rotation*: Graceful rotation where the old key remains valid for
  the maximum token TTL, then immediate rotation for security incidents.

== Authorization (Layer 3)

Once authenticated, every operation is authorized via the *Cedar policy
engine*. Cedar evaluates each action against a policy set that maps
principal roles to permitted operations:

#figure(
  table(
    columns: (auto, 1fr),
    table.header([*Role*], [*Permitted Actions*]),
    [ADMIN], [All actions],
    [NODE], [iBGP operations, gateway configuration],
    [NODE_CUSTODIAN], [Peer management, iBGP operations],
    [DATA_CUSTODIAN], [Route management],
    [USER], [Read-only: peer list, route list],
  ),
  caption: [Cedar authorization role matrix.],
) <tab-roles>

Authorization is enforced at two levels: an entry-point gate on the RPC
sub-API (e.g., `getIBGPClient(token)` validates the token and broad
capability), and per-operation Cedar checks within each handler.

== Route Origin Security

In production deployments, each route is signed by the originating node's
private key. Receiving nodes validate the signature chain against their
trusted certificate authority. This prevents route hijacking — a
compromised intermediate node cannot forge routes claiming to originate
from another node.

// ══════════════════════════════════════════════════════════
= Operational Considerations <operations>
// ══════════════════════════════════════════════════════════

== Deployment

Each Catalyst Node is packaged as a set of containers (orchestrator,
Envoy, gateway, auth) managed by Docker Compose or an orchestration
platform. All containers share a local network and communicate via
`capnweb` RPC.

Configuration is static at startup, loaded from a JSON config file or
CLI arguments. Dynamic reconfiguration is scoped to route table changes
propagated through peering.

== Observability

All components emit telemetry via OpenTelemetry:

- *Traces*: distributed request tracing across services and nodes.
- *Metrics*: Prometheus-compatible metrics for peer session health,
  route table size, RIB dispatch latency, and Envoy proxy statistics.
- *Logs*: structured logging via LogTape with hierarchical log sinks.

The OTEL Collector aggregates telemetry from all pod components and
exports to configured backends (Prometheus, Jaeger, InfluxDB). Only
Apache 2.0 or MIT licensed backends are permitted per the project
constitution.

== Failure Modes

#figure(
  table(
    columns: (auto, 1fr),
    table.header([*Failure*], [*Behavior*]),
    [Peer transport error],
      [Routes marked stale; automatic reconnect with exponential backoff.
       Stale routes expire if peer doesn't reconnect within hold time.],
    [Hold timer expiry],
      [Peer's routes removed; port allocations released. Reconnect
       attempted if configured.],
    [Node crash],
      [On restart, RIB state rebuilt from SQLite journal replay.
       Peers detect transport error and enter graceful restart.],
    [Auth service unavailable],
      [New peer sessions cannot authenticate. Existing sessions
       continue until token expiry.],
  ),
  caption: [Failure modes and system behavior.],
) <tab-failures>

== Service Lifecycle

All Catalyst services inherit from `CatalystService`, which provides a
unified lifecycle state machine:

#align(center)[
  `created` #sym.arrow `initializing` #sym.arrow `ready` #sym.arrow
  `shutting_down` #sym.arrow `stopped`
]

This ensures consistent startup ordering, graceful shutdown with
connection draining, and automatic telemetry setup across all components.

// ══════════════════════════════════════════════════════════
= Future Work <future>
// ══════════════════════════════════════════════════════════

== External Peering (eBGP)

Milestone 3 will introduce cross-organization peering. Nodes from
different administrative domains will exchange routes filtered by an
export policy (only services marked for external visibility). Trust
establishment will use JWKS discovery rather than shared certificate
authorities.

== Route Reflection

For large internal meshes, a route reflector role will reduce the
$O(n^2)$ full-mesh peering requirement. Designated reflector nodes will
redistribute routes to their clients, following BGP route reflector
semantics (RFC 4456).

== Multi-Path Routing

The current best-path selection uses shortest `nodePath` only. Future
work will support ECMP (Equal-Cost Multi-Path) routing where multiple
paths of equal length are used for load distribution.

== Post-Quantum TLS

As post-quantum cryptographic standards mature (ML-KEM, ML-DSA), Catalyst
will transition to hybrid key exchange (X25519 + ML-KEM-768) for
forward-secure inter-node communication. BoringSSL (used by Envoy)
already supports these algorithms experimentally.

== Advanced Observability

Planned enhancements include BGP-style route table visualization, peer
session health dashboards, and convergence time metrics for multi-node
topologies.

// ══════════════════════════════════════════════════════════
= References
// ══════════════════════════════════════════════════════════

+ Y. Rekhter, T. Li, S. Hares. "A Border Gateway Protocol 4 (BGP-4)."
  RFC 4271, January 2006.

+ T. Bates, R. Chandra, E. Chen. "BGP Route Reflection — An Alternative
  to Full Mesh iBGP." RFC 4456, April 2006.

+ Envoy Proxy Documentation. "Life of a Request."
  #link("https://www.envoyproxy.io/docs/envoy/latest/intro/life_of_a_request")

+ Cedar Policy Language.
  #link("https://www.cedarpolicy.com/")

+ Cap'n Proto RPC Protocol.
  #link("https://capnproto.org/rpc.html")

+ OpenTelemetry Specification.
  #link("https://opentelemetry.io/docs/specs/otel/")
