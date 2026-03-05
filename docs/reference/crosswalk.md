# Catalyst Project Crosswalk

This document maps the concepts from the legacy `catalyst` project (GitHub) to the new `catalyst-router` objectives, annotated with the specific **Implementation Phase** that delivers the capability.

> **Last reviewed**: 2026-03-05. Updated to reflect v2 routing system and completed milestones.

## Conceptual Mapping

| Feature Area                 | Legacy (Today)                                             | New Vision (catalyst-router)                                                             | Milestone | Status      |
| :--------------------------- | :--------------------------------------------------------- | :--------------------------------------------------------------------------------------- | :-------- | :---------- |
| **Organizational Construct** | **Organization**: The primary tenant.                      | **Organization**: Remains the primary construct. Defines the boundary of the mesh.       | M0        | Done        |
| **Data Channels / Services** | **Data Channels**: Assigned to an Org (FQDN/IP).           | **Service Mesh / Gateway**: Organizations build a service mesh of their own services.    | M0        | Done        |
| **Internal Routing**         | N/A (single-node only)                                     | **iBGP Peering**: Path-vector route exchange via Cap'n Proto RPC between same-org nodes. | M2        | Done        |
| **Connectivity**             | **Partnerships**: Orgs explicitly "partner" to share data. | **External Peering (eBGP)**: Organizations peer to share exported services.              | M3        | Planned     |
| **Access Control**           | **API Tokens**: Gateway built off User API Token.          | **Cedar Policy + JWT**: Cedar authorization engine with certificate-bound JWTs.          | M1        | Done        |
| **Identity**                 | **Token Minting**: Orgs can mint API tokens.               | **Auth Service**: Standalone sidecar for key management, JWT issuance/verification.      | M1        | Done        |
| **Data Plane**               | Direct HTTP between gateways                               | **Envoy Sidecar**: xDS-driven proxy for ingress/egress with dynamic port allocation.     | M4        | In progress |

## Detailed Breakdown & Parity Notes

### 1. The Organizational Construct

- **Legacy**: Organizations are the root entity.
  - _Deep Audit Details_:
    - **Roles**: Strictly defined as `admin`, `data_custodian`, `user`.
    - **Invites**: Contain a `message` field and strict state machine (`pending`, `accepted`, `declined`). Enforces "One Pending Invite" per Org-Pair.
- **New**: Organizations are the administrative domain.
  - **Milestone**: **M0** (Single Gateway). Done.
  - _Gap_: We need to decide if we hardcode the same 3 roles or allow flexible RBAC. (Recommendation: Flexible).

### 2. Service Mesh & API Gateway (Data Channels)

- **Legacy**: "Data Channels" are registered endpoints.
  - _Deep Audit Details_:
    - **Metadata**: `accessSwitch` (Global Killswitch), `endpoint`, `description`. NO complex labeling or weighting found in schema.
    - **Certification**: Separate app checks for GraphQL Federation compatibility.
- **New**: The Node allows organizations to build a **Service Mesh / API Gateway**.
  - **Milestone**: **M0** (Local Gateway). Done.
  - v2 routing uses `DataChannelDefinition` schema with `name`, `protocol`, `endpoint`, `region`, `tags`, `envoyPort`.
  - _Parity_: We must implement a "Service Killswitch" to match the `accessSwitch` capability.

### 3. Internal Peering (iBGP)

- **Legacy**: Single-node only — no peering capability.
- **New**: BGP-inspired path-vector routing between same-organization nodes.
  - **Milestone**: **M2** (Internal Peering). Done.
  - v2 implementation: `RoutingInformationBase` (RIB) with pure `plan()`/`commit()`, `OrchestratorBus` for dispatch, `PeerTransport` for WebSocket RPC.
  - Features: loop detection via `nodePath`, hold timer keepalive, graceful restart (stale marking on `TRANSPORT_ERROR`), best-path selection (shortest path wins).

### 4. External Peering (eBGP)

- **Legacy**: Orgs can "partner" via Matchmaking.
  - _Deep Audit Details_:
    - **Mailbox Pattern**: Invites are stored in sender/receiver "mailboxes".
    - **Toggle**: Existing partnerships can be toggled `isActive: true/false` without deletion.
- **New**: "Partnerships" allow another Org to access their services.
  - **Milestone**: **M3** (External Peering). Planned.
  - _Parity_: Our Peering state machine (`Idle`, `Connect`, `Active`) closely mirrors the Invite/Active flow.
  - Will require route export policy filtering.

### 5. Identity & Access Control

- **Legacy**:
  - **Deep Audit Details**:
    - **Token Signing**: `authx_token_api` checks specific claims against `UserSchema` before signing.
    - **Key Rotation**: explicit `rotateKey` admin endpoint.
- **New**:
  - **Milestone**: **M1** (Identity). Done.
  - Auth service with ECDSA key management, JWT issuance/verification.
  - Cedar policy engine for authorization (ADR-0015).
  - Certificate-bound access tokens for iBGP sessions (ADR-0007).
  - _Parity_: Key rotation is managed by the Auth Service key manager.

### 6. Data Plane (Envoy)

- **Legacy**: Direct HTTP between gateways.
- **New**: Envoy sidecar for all inter-node traffic.
  - **Milestone**: **M4** (Envoy Data Plane). In progress.
  - xDS server (LDS/CDS/RDS) implemented in orchestrator.
  - Dynamic port allocation via `PortOperation` type.
  - mTLS preparation underway.

## High-Level Alignment

| Legacy Construct   | New Objective               | Notes                                                           | Milestone | Status      |
| :----------------- | :-------------------------- | :-------------------------------------------------------------- | :-------- | :---------- |
| **Organization**   | **Organization**            | Direct mapping.                                                 | M0        | Done        |
| **Data Channel**   | **Service in Mesh**         | "Data Channel" is the legacy term for an exposed service.       | M0        | Done        |
| **—**              | **Internal Peering (iBGP)** | New capability — multi-node route exchange.                     | M2        | Done        |
| **Partnership**    | **External Peering (eBGP)** | The business intent is "Partnership"; the mechanism is Peering. | M3        | Planned     |
| **RelBAC / AuthZ** | **Cedar Policy Engine**     | Cedar replaces the original minimal policy layer.               | M1        | Done        |
| **API Token**      | **Certificate-Bound JWT**   | JWT with cert binding for mutual auth.                          | M1        | Done        |
| **Direct HTTP**    | **Envoy Data Plane**        | Universal ingress/egress proxy with xDS config.                 | M4        | In progress |

## Missing Capabilities (Gaps)

While the core functional pillars are mapped, the following features found in the legacy repo are **not yet explicitly planned**:

1. **Schema Certification / Registry**:
   - _Legacy_: `data-channel-certifier` performs SDL Federation validation before a service is active.
   - _New Plan_: Implicitly handled by the Gateway/Mesh, but no explicit "Certification" step or Registry exists.
   - _Recommendation_: Add a `verification` step to validate Peer Schemas.

2. **Compliance Auditing**:
   - _Legacy_: Audit logs for permission/role changes in `authx` APIs.
   - _New Plan_: The journal/action log provides an audit trail for routing decisions. Broader audit logging (who changed what policy) is not yet implemented.
   - _Recommendation_: Extend the action journal pattern to the auth and policy layers.

3. **Endpoint Validation**:
   - _Legacy_: `data-channel-certifier` validates the reachability and health of the endpoint (URL) alongside the schema.
   - _New Plan_: Envoy health checks will cover this once M4 is complete.
   - _Recommendation_: Integrate **Active Health Checks** (Envoy) and startup validation.

4. **Route Export Policy**:
   - Required for M3 (External Peering) — only exported services should be advertised to external peers.
   - The `RoutePolicy` interface in `@catalyst/routing` is the hook point for this.
