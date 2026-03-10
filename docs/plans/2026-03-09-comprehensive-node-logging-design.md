# Comprehensive Node Logging — Design

**Goal:** Complete structured logging coverage across all Catalyst Router services so operators can diagnose any issue from logs alone, without SSH access.

**Context:** The WideEvent class, HTTP middleware, and OTEL pipeline are already in place (PRs #520-#524). This work adds ~45 new event types to cover the remaining gaps identified in the Node Logs ticket (P0) and broader operational needs.

**Approach:** Organized by operator question rather than by service. Every event answers a specific debugging question. Uses the existing `logger.info("message {key}", { "event.name": "...", key: value })` pattern and WideEvent class where appropriate.

---

## 1. Node Lifecycle & Bootstrap

Events for node startup, shutdown, and first-time setup.

| Event                           | Key Fields                                        | Question Answered                       |
| ------------------------------- | ------------------------------------------------- | --------------------------------------- |
| `node.startup.completed`        | `duration_ms`, services loaded, config source     | Did the node come up? How long?         |
| `node.startup.failed`           | `error.type`, `error.message`, failing service    | Why didn't the node start?              |
| `node.config.loaded`            | `node_id`, `domains`, `peering_endpoint`          | What config is this node running?       |
| `node.config.defaults_used`     | defaulted fields and values                       | Is this node misconfigured?             |
| `node.shutdown.initiated`       | `reason` (signal, error, manual), `graceful`      | Did it shut down cleanly?               |
| `node.shutdown.completed`       | `duration_ms`, peers disconnected, cleanup status | Did it clean up after itself?           |
| `node.bootstrap.token_acquired` | `token_subject`, `auth_endpoint`                  | Did first-time auth work?               |
| `node.bootstrap.token_failed`   | `error.type`, `auth_endpoint`, attempt count      | Why can't this fresh node authenticate? |

Also: convert the 9 V2 orchestrator template literals to structured logging.

## 2. Peering & Network Health

Highest-value area — peering issues are the hardest to debug remotely.

| Event                        | Key Fields                                                        | Question Answered                     |
| ---------------------------- | ----------------------------------------------------------------- | ------------------------------------- |
| `peer.session.state_changed` | `from_state`, `to_state`, `peer.name`, `peer.endpoint`            | What state is the peering session in? |
| `peer.keepalive.sent`        | `peer.name`, `rtt_ms`                                             | Is the link healthy?                  |
| `peer.keepalive.timeout`     | `peer.name`, `missed_count`, `threshold`                          | Why did it disconnect?                |
| `peer.reconnect.attempt`     | `peer.name`, `attempt_number`, `backoff_ms`, `strategy`           | Is it trying to reconnect?            |
| `peer.reconnect.succeeded`   | `peer.name`, `attempt_number`, `total_downtime_ms`                | How long was the link down?           |
| `peer.reconnect.exhausted`   | `peer.name`, `total_attempts`, `total_elapsed_ms`                 | Did it give up?                       |
| `peer.auth.failed`           | `peer.name`, `reason` (expired_cert, wrong_domain, policy_denial) | Why can't these nodes peer?           |
| `peer.partition.detected`    | `lost_peer_count`, `lost_peers[]`, `detection_method`             | Did we lose the network?              |
| `peer.partition.recovered`   | `recovered_peer_count`, `partition_duration_ms`                   | When did it come back?                |

Partition detection heuristic: 3+ peers lost within 10s = likely network partition.

## 3. Route Exchange & Convergence

| Event                         | Key Fields                                              | Question Answered                              |
| ----------------------------- | ------------------------------------------------------- | ---------------------------------------------- |
| `route.convergence.completed` | `peer.name`, `route_count`, `convergence_ms`            | How long after peering did routes stabilize?   |
| `route.table.snapshot`        | `total_routes`, `by_protocol`, `by_peer`                | What does the routing table look like?         |
| `route.install.completed`     | `route.name`, `source_peer`, `protocol`, `install_ms`   | When did this route become usable?             |
| `route.install.rejected`      | `route.name`, `reason` (loop, policy, conflict)         | Why was this route rejected?                   |
| `route.conflict.detected`     | `route.name`, `existing_peer`, `new_peer`, `resolution` | Two peers advertised the same route — who won? |
| `route.stale.detected`        | `route.name`, `peer.name`, `age_ms`                     | Are there zombie routes?                       |
| `route.table.changed`         | `added`, `removed`, `modified`, `trigger`               | What caused the routing table to change?       |

## 4. Gateway & Federation

| Event                             | Key Fields                                         | Question Answered                  |
| --------------------------------- | -------------------------------------------------- | ---------------------------------- |
| `gateway.subgraph.health_changed` | `subgraph.name`, `from_status`, `to_status`        | Is a subgraph degraded?            |
| `gateway.subgraph.sdl_validated`  | `subgraph.name`, `valid`, `errors[]`               | Which service has a bad schema?    |
| `gateway.query.routed`            | `operation_name`, `subgraphs_hit[]`, `duration_ms` | Where did this query go?           |
| `gateway.query.failed`            | `operation_name`, `subgraph.name`, `error.type`    | Which subgraph caused the failure? |
| `gateway.stitching.completed`     | `subgraph_count`, `type_count`, `duration_ms`      | How big is the federated schema?   |

## 5. Data Plane (Envoy)

| Event                           | Key Fields                                             | Question Answered                   |
| ------------------------------- | ------------------------------------------------------ | ----------------------------------- |
| `envoy.upstream.health_changed` | `cluster.name`, `endpoint`, `from_status`, `to_status` | Is a backend down?                  |
| `envoy.config.diff`             | `clusters_added/removed`, `listeners_added/removed`    | What changed in the last xDS push?  |
| `envoy.nack.repeated`           | `client_id`, `resource_type`, `nack_count`             | Is a client stuck rejecting config? |
| `envoy.traffic.routed`          | `cluster.name`, `upstream.address`, `duration_ms`      | Where did the traffic go?           |

## 6. Security & Audit

| Event                          | Key Fields                                                       | Question Answered                        |
| ------------------------------ | ---------------------------------------------------------------- | ---------------------------------------- |
| `auth.decision.logged`         | `principal`, `action`, `resource`, `allowed`, `policy_reasons[]` | Why was this allowed/denied?             |
| `auth.cert.rotation.started`   | `old_key_id`, `new_key_id`, `grace_period`                       | When did cert rotation begin?            |
| `auth.cert.rotation.completed` | `old_key_id`, `new_key_id`, `tokens_migrated`                    | Did rotation finish cleanly?             |
| `auth.cert.expiring_soon`      | `key_id`, `expires_at`, `time_remaining_ms`                      | Are we about to have an outage?          |
| `auth.token.usage`             | `token_subject`, `action`, `source_ip`, `token_age_ms`           | Who's using which tokens?                |
| `auth.token.mint.failed`       | `reason` (auth, transport, policy), `subject`                    | Why did minting fail?                    |
| `auth.policy.evaluation`       | `principal`, `action`, `decision`, `determining_policies[]`      | Which Cedar policy caused this decision? |

## Summary

- ~45 new event types across 6 categories
- 9 template literal conversions in V2 orchestrator
- Combined with existing ~74 events = comprehensive coverage
- All events use existing WideEvent + structured logging infrastructure
- No new architecture or dependencies required

## References

- [Node Logs ticket (P0)](https://www.notion.so/31947ad1da7980c581d2e93b1f5a4674)
- [Instrumentation & Logs epic](https://www.notion.so/31847ad1da7980d494d2d65df833deb0)
- [OTel Log Data Model](https://opentelemetry.io/docs/specs/otel/logs/data-model/)
- [LogTape Structured Logging](https://logtape.org/manual/struct)
- [Stripe: Canonical Log Lines](https://stripe.com/blog/canonical-log-lines)
- [Wide Events](https://loggingsucks.com)
