# PRD: Catalyst Node — Video Streaming

| Field            | Value                 |
| ---------------- | --------------------- |
| **Product**      | Catalyst Node         |
| **Project**      | POC — Video Streaming |
| **Version**      | 1.0.0                 |
| **Status**       | Draft                 |
| **Last Updated** | 2026-02-13            |

## Change History

| Date       | Author | Changes       |
| ---------- | ------ | ------------- |
| 2026-02-13 |        | Initial draft |

---

## 1. Problem Statement

### What problem are we solving?

Catalyst-node operates in field environments where nodes have unstable connectivity, changing IPs, and NAT constraints. Field operators need to publish camera streams from their nodes, command centers need to discover and consume those streams across the mesh, and recordings must persist locally when connectivity drops.

This PRD defines the Video Streaming capability that extends the existing catalyst-node platform with real-time media stream publishing, mesh-wide discovery, authorized consumption, and local durable recording. Streams are treated as first-class routable entities propagated via the existing iBGP mechanism.

### Why now?

The current routing architecture handles HTTP-based service discovery but has no concept of media streams. Field operations increasingly depend on live camera feeds for situational awareness, and the decentralized mesh architecture is uniquely positioned to support peer-to-peer media distribution without central coordination.

### Goal

A field operator connects a camera via RTSP, the stream auto-registers as a media route, propagates to peers via iBGP, and a command center user views it through their local node's media server — all gated by Cedar authorization policies and JWT authentication.

### Competitive Context

**Competitive Advantages:**

- No central coordination — streams route via decentralized iBGP mesh
- Self-contained — each node manages its own MediaMTX sidecar
- Built for trust boundaries — Cedar ABAC governs all stream access
- Works in disconnected environments — local recording persists footage during outages

**Market White Spaces:**

Existing video streaming solutions assume stable connectivity and centralized management servers. Catalyst addresses the underserved space of decentralized, policy-governed media distribution across organizational boundaries in field environments.

---

## 2. Vision & Mission

**Vision:** Extend catalyst-node into a unified data and media mesh where video streams are as discoverable, routable, and policy-governed as any other service endpoint.

**Mission:** Deliver a VideoStreamService that manages a MediaMTX media server sidecar, integrates with the existing routing, authorization, and peering infrastructure, and provides zero-touch stream lifecycle management for field deployments.

---

## 3. Target Users

### Primary User: Field Operators

**Who:** Deploy and operate nodes in the field with connected cameras
**Pain points:**

- Need to publish camera streams with zero manual route management
- Operate in disconnected or degraded network environments

**Why they matter:** Core users driving the need for decentralized media distribution

### Secondary User: Command Center Users

**Who:** Monitor feeds from a central location across the mesh
**Pain points:**

- Need to discover and view all available streams transparently
- Same experience regardless of which node publishes the stream

**Why they matter:** Primary consumers of the federated video capability

### Tertiary User: Administrators

**Who:** Configure Cedar policies controlling stream publish and subscribe access
**Pain points:**

- Need the same authorization model used for all other platform capabilities

**Why they matter:** Ensure security and compliance of stream access

---

## 4. User Stories

Prioritized using MoSCoW. Must Have stories define the core publish-discover-consume-authorize loop.

### Must Have

**US-1: Publish a Camera Stream** — As a field operator, I can publish a camera stream from my node so that other nodes in the mesh can discover and view it.

- Camera connects via RTSP to local MediaMTX; publish authorized via node-level trust
- Local route created with protocol: 'media' and node-prefixed path (e.g., nodeA/cam-front)
- On disconnect, onNotReady fires and route is removed via LocalRouteDelete
- In v1, local publish uses the node-managed route lifecycle. If the node is not allowed to register the route in its domain/node context, the publish is rejected with 401

**US-2: Discover Streams Across the Mesh** — As a command center user, I can see all available video streams across the mesh.

- Stream routes propagate to all peers via iBGP UPDATE with nodePath loop prevention
- Remote streams appear with endpoint, source peer info, and metadata tags
- When stream goes offline, withdrawal propagates and route removed from peer tables

**US-3: Subscribe to a Remote Stream** — As a command center user, I can view a stream from a remote field node through my local media server.

- MediaMTX pulls remote stream on-demand (sourceOnDemand) when consumer requests it
- Consumer JWT validated and Cedar evaluates the existing route visibility policy for the target domain/node context. In v1, stream viewing reuses route read access rather than a distinct stream-specific action
- Multi-protocol output: RTSP, HLS, WebRTC, SRT simultaneously from same source

**US-4: Control Stream Access via Existing Cedar Roles** — As an admin, I can use the current Cedar role model to control who can publish stream routes and who can discover or view streams.

| Role               | Publish Stream (v1) | Discover/View Stream (v1) | Constraint  | Notes                                                          |
| ------------------ | ------------------- | ------------------------- | ----------- | -------------------------------------------------------------- |
| **ADMIN**          | Permit              | Permit                    | Domain/Node | Full access                                                    |
| **NODE**           | Internal only       | Deny                      | Domain/Node | Used for node-managed local publish path, not end-user viewing |
| **NODE_CUSTODIAN** | Deny                | Deny                      | Domain/Node | Peer-topology role; no route permissions                       |
| **DATA_CUSTODIAN** | Permit              | Permit                    | Domain/Node | Existing route owner role                                      |
| **USER**           | Deny                | Permit                    | Domain/Node | Read-only stream discovery/viewing                             |

### Should Have

**US-5: Automatic Stream Route Lifecycle** — Streams auto-register/deregister via MediaMTX runOnReady/runOnNotReady hooks.

**US-6: Local Durable Recording** — Append-only GOP log persists locally regardless of connectivity. Each block independently decodable.

### Won't Have (This Release)

- **US-7: Store-and-Forward Replication** — Recordings replicate to peers after reconnect
- **US-8: Recording Integrity Verification** — Merkle tree tamper-evidence per block

---

## 5. Requirements

### P0 — Must Have (Launch Blockers)

#### FR-1: Stream Publishing

The system shall allow cameras and media sources to publish video streams to a node.

| ID    | Requirement                                                                                    | Acceptance Criteria                             |
| ----- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| FR-1a | Accept incoming video streams via RTSP, SRT, HLS, and WebRTC protocols                         | - [ ] All four protocols tested                 |
| FR-1b | Auto-register stream as a named route visible to local node when camera connects               | - [ ] Route appears in routing table on publish |
| FR-1c | Each stream identified by globally unique name prefixed with node name (e.g., nodeA/cam-front) | - [ ] No naming collisions across mesh          |
| FR-1d | Auto-remove stream route when camera disconnects or stream stops                               | - [ ] Route removed within 2s of disconnect     |
| FR-1e | Auto-restart media server on crash (up to 3 retries) and clean up stale routes                 | - [ ] Stale routes cleaned after crash recovery |

#### FR-2: Stream Discovery

The system shall enable users to discover all available video streams across the mesh.

| ID    | Requirement                                                                               | Acceptance Criteria                                   |
| ----- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| FR-2a | Recognize video streams as a distinct route type alongside HTTP service routes            | - [ ] Media routes distinguishable in routing table   |
| FR-2b | Propagate stream routes to all connected peers via existing peering mechanism             | - [ ] Route appears on peer within 2s                 |
| FR-2c | Propagate route withdrawal when stream goes offline                                       | - [ ] Withdrawal reaches peers within 2s              |
| FR-2d | Remove all stream routes from a peer when that peer disconnects                           | - [ ] No stale remote routes after peer disconnect    |
| FR-2e | Include metadata (codec, source node, source type) in stream routes                       | - [ ] Metadata present and filterable                 |
| FR-2f | Provide API endpoint listing all known streams (local and remote) with optional filtering | - [ ] GET /video-stream/streams returns expected data |

#### FR-3: Stream Viewing

The system shall allow authorized users to view streams published by any node in the mesh.

| ID    | Requirement                                                                             | Acceptance Criteria                    |
| ----- | --------------------------------------------------------------------------------------- | -------------------------------------- |
| FR-3a | Auto-pull remote stream on demand when user requests it                                 | - [ ] Stream begins playing on request |
| FR-3b | Close pull connection when last viewer disconnects                                      | - [ ] No orphaned connections          |
| FR-3c | Serve same source stream via multiple protocols simultaneously (RTSP, HLS, WebRTC, SRT) | - [ ] All protocols serve same stream  |
| FR-3d | Stop relaying when remote stream route is withdrawn                                     | - [ ] Relay stops on withdrawal        |

#### FR-4: Authentication & Authorization

The system shall enforce access control on all stream publishing and viewing operations.

| ID    | Requirement                                                                                                                                                                                  | Acceptance Criteria                                |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| FR-4a | Authorize local camera publish using node's own identity (no separate camera credentials)                                                                                                    | - [ ] Local camera publishes without extra auth    |
| FR-4b | Reject publish attempts from remote IPs                                                                                                                                                      | - [ ] Remote publish rejected                      |
| FR-4c | Validate viewer JWT and evaluate the existing Cedar route visibility policy before granting stream access                                                                                    | - [ ] Unauthorized viewer denied                   |
| FR-4d | Return appropriate error on authorization failure                                                                                                                                            | - [ ] Error response returned                      |
| FR-4e | Ship default Cedar policies that reuse the existing role model: local publish via node trust, stream route registration via route permissions, and discovery/view via route read permissions | - [ ] Default policies enforce the v1 access model |
| FR-4f | Configurable fail mode: fail-closed for publish and view when auth unreachable                                                                                                               | - [ ] Behavior matches configuration               |

#### FR-5: Configuration

The system shall be configurable via environment variables following existing platform conventions.

| Variable                           | Description                                 | Default      |
| ---------------------------------- | ------------------------------------------- | ------------ |
| CATALYST_VIDEO_ENABLED             | Enable or disable video streaming           | false        |
| CATALYST_VIDEO_RTSP_PORT           | Port for RTSP connections                   | 8554         |
| CATALYST_VIDEO_SRT_PORT            | Port for SRT connections                    | 8890         |
| CATALYST_VIDEO_HLS_PORT            | Port for HLS connections                    | 8888         |
| CATALYST_VIDEO_WEBRTC_PORT         | Port for WebRTC connections                 | 8889         |
| CATALYST_VIDEO_RECORDING_ENABLED   | Enable local recording                      | false        |
| CATALYST_VIDEO_RECORDING_PATH      | Directory for recording files               | ./recordings |
| CATALYST_VIDEO_AUTH_FAIL_PUBLISH   | Behavior when auth is unreachable (publish) | closed       |
| CATALYST_VIDEO_AUTH_FAIL_SUBSCRIBE | Behavior when auth is unreachable (view)    | closed       |

### P1 — Should Have (Important)

#### FR-6: Local Recording

The system shall record published streams locally on the node for durability during connectivity outages.

| ID    | Requirement                                                                             | Acceptance Criteria                     |
| ----- | --------------------------------------------------------------------------------------- | --------------------------------------- |
| FR-6a | Persist all video data to local storage as stream is published (when recording enabled) | - [ ] Recording file written on publish |
| FR-6b | Continue recording uninterrupted regardless of network connectivity                     | - [ ] No data lost during outage        |
| FR-6c | Store in seekable format where any segment can be played independently                  | - [ ] Random segment playback works     |
| FR-6d | Write stream metadata (codec, resolution, framerate, source node) at recording start    | - [ ] Metadata present in recording     |
| FR-6e | Include format versioning for future evolution without breaking existing recordings     | - [ ] Version header present            |

### P2 — Won't Have (Future)

#### FR-7: Store-and-Forward Replication

Deferred to a future phase. The system shall replicate recordings to peer nodes after connectivity is restored.

| ID    | Requirement                                                    | Acceptance Criteria                       |
| ----- | -------------------------------------------------------------- | ----------------------------------------- |
| FR-7a | Transmit only missing recording segments on reconnect          | - [ ] Delta sync only                     |
| FR-7b | Include cryptographic integrity proofs for tamper verification | - [ ] Receiving node can verify integrity |

---

## 6. Non-Goals (Out of Scope)

Explicitly NOT included in this initiative:

| Item                  | Rationale                                                              | Future Consideration? |
| --------------------- | ---------------------------------------------------------------------- | --------------------- |
| Media over QUIC (MoQ) | IETF spec not yet stable. Protocol enum designed for future moq value. | Yes                   |
| Transcoding / ABR     | MediaMTX handles protocol translation only, not transcoding.           | TBD                   |
| Multi-node recording  | Local recording + P2P replication only. Central management deferred.   | Yes                   |
| Browser management UI | CLI and API sufficient. mesh-admin extension is separate feature.      | Yes                   |
| Store-and-forward     | Requires durable recording first. Deferred to future phase.            | Yes — Phase 3         |
| Recording integrity   | Merkle tree verification deferred with store-and-forward.              | Yes — Phase 3         |

---

## 7. Scope

### In Scope

| Area             | Scope                                                   |
| ---------------- | ------------------------------------------------------- |
| **Service**      | VideoStreamService extending CatalystService            |
| **Media Server** | MediaMTX sidecar (managed child process)                |
| **Protocols**    | RTSP, SRT, HLS, WebRTC (multi-protocol output)          |
| **Routing**      | Media routes via existing iBGP with protocol: 'media'   |
| **Auth**         | JWT + Cedar ABAC using existing route permissions in v1 |
| **Relay**        | On-demand pull via MediaMTX sourceOnDemand              |
| **Discovery**    | GET /video-stream/streams endpoint                      |
| **Recording**    | Local append-only GOP log (Should Have)                 |

---

## 8. Non-Functional Requirements

- Auth hook latency < 100ms added to stream connection time (JWT verification + Cedar evaluation)
- Stream route appears in peer routing tables within 2 seconds of readiness
- Stream route withdrawn within 2 seconds of going offline
- Local recording captures 100% of published GOPs regardless of network state
- VideoStreamService starts within existing service initialization budget
- MediaMTX publish port bound to localhost only to prevent remote rogue publishing
- Self-contained with no external service dependencies beyond MediaMTX binary

---

## 9. Assumptions & Risks

### Risks

| Risk                                                                                   | Likelihood | Impact | Mitigation                                                                                     |
| -------------------------------------------------------------------------------------- | ---------- | ------ | ---------------------------------------------------------------------------------------------- |
| NAT reachability — On-demand pull requires consuming node to reach publisher RTSP port | H          | H      | SRT rendezvous mode or future MoQ transport                                                    |
| MediaMTX crash — Active stream routes must be cleaned up                               | M          | H      | Restart logic with route reconciliation on recovery                                            |
| Camera flapping — Rapid connect/disconnect churns routing table                        | M          | M      | Debounce route creation/deletion                                                               |
| JWT expiry during active stream                                                        | L          | L      | Stream continues until token expires; re-auth on next connection only                          |
| Auth service unreachable                                                               | M          | H      | Fail closed for publish and view; operators must restore auth before new sessions are accepted |
| Disk pressure during recording                                                         | M          | M      | Stop recording with alert, or implement circular buffer for oldest segments                    |
| IP change mid-stream                                                                   | M          | M      | SRT connections break; future MoQ/QUIC solves at transport layer                               |

---

## 10. Dependencies

| Dependency                 | Description                                             |
| -------------------------- | ------------------------------------------------------- |
| MediaMTX media server      | External sidecar binary, managed as child process       |
| CatalystService base class | Existing base class and orchestrator dispatch mechanism |
| Cedar policy engine        | Existing ABAC authorization                             |
| JWT auth infrastructure    | Existing token verification                             |
| iBGP route propagation     | Existing UPDATE / WITHDRAW mechanism                    |
| DataChannel routing        | Extended with 'media' protocol                          |

---

## 11. Timeline

| Phase       | Scope                                | Deliverables                                                                |
| ----------- | ------------------------------------ | --------------------------------------------------------------------------- |
| **Phase 1** | Must Have — Core Streaming           | Publish, discover, subscribe, Cedar auth (FR-1 through FR-5)                |
| **Phase 2** | Should Have — Automation & Recording | Automatic lifecycle hooks, local durable recording (FR-6)                   |
| **Phase 3** | Future — Replication & Integrity     | Store-and-forward, Merkle verification, MoQ transport (FR-7 + MoQ protocol) |

---

## 12. Open Questions

| Question | Owner | Due Date | Resolution |
| -------- | ----- | -------- | ---------- |
|          |       |          |            |

---

## Appendix

### A. Related PRDs

- [0001-poc-graphql-parity.md](./0001-poc-graphql-parity.md)

---

_End of Document_
