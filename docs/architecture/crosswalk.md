# Catalyst Project Crosswalk

This document maps the concepts from the legacy `catalyst` project (GitHub) to the new `catalyst-router` objectives, annotated with the specific **Implementation Phase** that delivers the capability.

## Conceptual Mapping

| Feature Area                 | Legacy (Today)                                             | New Vision (Objectives)                                                                                            | Fulfillment Phase                                           |
| :--------------------------- | :--------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------- |
| **Organizational Construct** | **Organization**: The primary tenant.                      | **Organization**: Remains the primary construct. Defines the boundary of the mesh.                                 | **Phase 1** (Basic Node Identity)                           |
| **Data Channels / Services** | **Data Channels**: Assigned to an Org (FQDN/IP).           | **Service Mesh / Gateway**: Organizations build a service mesh of their own services.                              | **Phase 1 & 2** (Local Services & Routing)                  |
| **Connectivity**             | **Partnerships**: Orgs explicitly "partner" to share data. | **Partnerships/Peering**: Organizations "partner" wherein another org can access their services.                   | **Phase 4** (External Peering)                              |
| **Access Control**           | **API Tokens**: Gateway built off User API Token.          | **Policy & Real-time Access**: Minimal policy declaration and enforcement layer enabling real-time access control. | **Phase 7** (Online Policy) & **Phase 8** (Offline Policy)  |
| **Identity**                 | **Token Minting**: Orgs can mint API tokens.               | **Identity Integration**: Orgs retain the ability to mint API tokens.                                              | **Phase 3** (Internal Trust) & **Phase 6** (Identity Infra) |

## Detailed Breakdown & Parity Notes

### 1. The Organizational Construct

- **Legacy**: Organizations are the root entity.
  - _Deep Audit Details_:
    - **Roles**: Strictly defined as `admin`, `data_custodian`, `user`.
    - **Invites**: Contain a `message` field and strict state machine (`pending`, `accepted`, `declined`). Enforces "One Pending Invite" per Org-Pair.
- **New**: Organizations are the administrative domain.
  - **Phase**: **Phase 1** (Basic Node Identity).
  - _Gap_: We need to decide if we hardcode the same 3 roles or allow flexible RBAC. (Recommendation: Flexible).

### 2. Service Mesh & API Gateway (Data Channels)

- **Legacy**: "Data Channels" are registered endpoints.
  - _Deep Audit Details_:
    - **Metadata**: `accessSwitch` (Global Killswitch), `endpoint`, `description`. NO complex labeling or weighting found in schema.
    - **Certification**: Separate app checks for GraphQL Federation compatibility.
- **New**: The Node allows organizations to build a **Service Mesh / API Gateway**.
  - **Phase**: **Phase 1** (Local Gateway) & **Phase 2** (Routing to Services).
  - _Parity_: We must implement a "Service Killswitch" to match the `accessSwitch` capability.

### 3. Partnering (Peering)

- **Legacy**: Orgs can "partner" via Matchmaking.
  - _Deep Audit Details_:
    - **Mailbox Pattern**: Invites are stored in sender/receiver "mailboxes".
    - **Toggle**: Existing partnerships can be toggled `isActive: true/false` without deletion.
- **New**: "Partnerships" allow another Org to access their services.
  - **Phase**: **Phase 4** (External Peering).
  - _Parity_: Our Peering state machine (`Idle`, `Connect`, `Active`) closely mirrors the Invite/Active flow.

### 4. Policy & Access Control

- **Legacy**:
  - **Deep Audit Details**:
    - **Token Signing**: `authx_token_api` checks specific claims against `UserSchema` before signing.
    - **Key Rotation**: explicit `rotateKey` admin endpoint.
- **New**:
  - **Phase**: **Phase 7** (Online Policy) & **Phase 8** (Offline Policy).
  - _Parity_: We need an explicit "Key Rotation" command in the CLI (Phase 3/6).

## High-Level Alignment

| Legacy Construct   | New Objective                 | Notes                                                                                         | Phase         |
| :----------------- | :---------------------------- | :-------------------------------------------------------------------------------------------- | :------------ |
| **Organization**   | **Organization**              | Direct mapping.                                                                               | **Phase 1**   |
| **Data Channel**   | **Service in Mesh**           | "Data Channel" is the legacy term for an exposed service.                                     | **Phase 1/2** |
| **Partnership**    | **Partnership (via Peering)** | The business intent is "Partnership"; the mechanism is Peering.                               | **Phase 4**   |
| **RelBAC / AuthZ** | **Minimal Policy Layer**      | Real-time enforcement. Simpler than full Zanzibar (RelBAC) but sufficient for access control. | **Phase 7/8** |
| **API Token**      | **API Token**                 | Direct mapping. Token minting and validation remains core.                                    | **Phase 3/6** |

## Missing Capabilities (Gaps)

While the core functional pillars are mapped, the following features found in the legacy repo are **not yet explicitly planned**:

1.  **Schema Certification / Registry**:
    - _Legacy_: `data-channel-certifier` performs SDL Federation validation before a service is active.
    - _New Plan_: Implicitly handled by the Gateway/Mesh, but no explicit "Certification" step or Registry exists.
    - _Recommendation_: Add a `verification` step in **Phase 2** to validate Peer Schemas.

2.  **Compliance Auditing**:
    - _Legacy_: Audit logs for permission/role changes in `authx` APIs.
    - _New Plan_: **Phase 9 (Observability)** covers metrics, but **Audit Logging** (who changed what policy) is missing.
    - _Recommendation_: Add structured Audit Logging to **Phase 7 (Policy Management)**.

3.  **Endpoint Validation**:
    - _Legacy_: `data-channel-certifier` validates the reachability and health of the endpoint (URL) alongside the schema.
    - _New Plan_: **Phase 2** covers routing, but active health checking/validation of specific service endpoints is not explicitly detailed.
    - _Recommendation_: Integrate **Active Health Checks** (Envoy) and startup validation in **Phase 2**.
