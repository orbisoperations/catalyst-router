# PRODUCT REQUIREMENTS DOCUMENT

**Product:** Catalyst Router
**Project:** POC — GraphQL Parity
**Version:** 1.0.0
**Date:** 2026-02-05
**Status:** Draft

---

## 1. Executive Summary

Catalyst Router is a distributed GraphQL federation and cross-organization data sharing system that uses BGP-inspired peering for decentralized service routing. This PRD defines the scope for a Proof of Concept (POC) that demonstrates Catalyst running as a portable virtual appliance — a self-contained, containerized system deployable via Docker Compose on x86_64 infrastructure and Raspberry Pi 5 (8GB). Catalyst v2 is an effort to inject new requirements on hosting and connectivity while consolidating functionality of the sprawling core.

**Why now:** Catalyst currently exists as a SaaS-only offering. Many organizations in regulated or other data environments cannot use SaaS. The virtual appliance model enables these organizations to participate in federated data sharing by hosting Catalyst on their own infrastructure.

**POC goal:** Demonstrate that two Catalyst routers can be deployed via Docker Compose, establish a peering relationship, and share GraphQL services across organizational boundaries, running as a self-contained appliance with no external dependencies on both x86_64 servers and Raspberry Pi 5 (8GB ARM64) hardware.

---

## 2. Vision & Mission

**Vision:** Transform Catalyst from a SaaS-only offering into a portable virtual appliance that can be hosted anywhere meeting minimum requirements — data clouds, data centers, and small form factor devices including Raspberry Pi 5.

**Mission:** Deliver a POC demonstrating basic Catalyst functionality (GraphQL federation and cross-organization data sharing) running as a self-contained, container-based appliance deployable via Docker Compose on x86_64 and ARM64 (Pi 5) infrastructure.

---

## 3. Target Audience

### Primary: Infrastructure Operators

- Engineers at organizations with on-premise or private cloud requirements
- Comfortable with Docker/k8s but not necessarily distributed systems experts
- May operate in regulated, air-gapped, or sovereign data environments
- **Need:** deploy Catalyst as an appliance and connect it to their data sources

### Secondary: Data Consumers

- Developers querying federated data (same as SaaS Catalyst users)
- **Need:** transparent experience so federation works the same regardless of deployment model

### Tertiary: Catalyst Team

- Internal team validating the virtual appliance model
- **Need:** POC that demonstrates feasibility and informs the product roadmap

---

## 4. Competitive Context

### Market Landscape

[To be determined]

### Competitive Advantages

- No central coordination
- Self contained
- Built for trust boundaries
- Works in disconnected environments

### Market White Spaces

Current solutions focus on intra-org federation. Catalyst addresses the underserved cross-organization data sharing and decentralized routing space.

### Target Segments

| Priority | Segment                   | Driver                |
| -------- | ------------------------- | --------------------- |
| Tier 1   | Cross-org use cases       | Defense               |
| Tier 2   | Regulated                 | FedRAMP               |
| Tier 3   | Multi-cloud / distributed | That's just how it is |

---

## 5. Scope

### In Scope

| Area          | Scope                                                  |
| ------------- | ------------------------------------------------------ |
| Deployment    | Docker Compose only                                    |
| Hardware      | x86_64 (amd64) + Raspberry Pi 5 8GB (arm64)            |
| Images        | Multi-arch container images (amd64 + arm64)            |
| Federation    | GraphQL schema stitching                               |
| Peering       | BGP-style, same Docker network, manual endpoint config |
| Auth          | JWT + Cedar ABAC                                       |
| Observability | LogTape structured logging + OTEL Collector            |
| Revocation    | Need persistent storage                                |
| Demo          | Simple example GraphQL services                        |

### Out of Scope

| Area                       | Rationale                                                  |
| -------------------------- | ---------------------------------------------------------- |
| Kubernetes deployment      | Compose-only for POC. k8s deferred.                        |
| Envoy data plane           | Not needed for GraphQL parity                              |
| Cross-network peering      | Same Docker network sufficient for POC.                    |
| Cross-service type merging | Advanced federation. Not needed for POC demo.              |
| GUI/dashboard              | CLI and API sufficient.                                    |
| GraphQL Mesh               | Not needed for GraphQL parity. Consider for another phase. |

---

## 6. User Personas

[To be determined]

---

## 7. Functional Requirements

### FR-1: GraphQL Federation

The system must compose multiple GraphQL schemas into a unified endpoint via schema stitching.

**Requirements:**

- Register local GraphQL services via CLI or API
- Gateway stitches registered service schemas into unified schema
- Queries against unified schema delegate to correct upstream service
- Zero-downtime schema reload when services are added or removed

---

### FR-2: Cross-Organization Data Sharing

Two Catalyst routers must be able to peer and share service routes.

**Requirements:**

- Add peer node via CLI
- Route updates propagated to peers
- Route withdrawal on peer disconnection
- Peered services appear in local Gateway federation

---

### FR-3: Authentication & Authorization

**Requirements:**

- Self-contained authorization
- JWKS endpoint for key distribution
- Key rotation and token revocation

---

### FR-4: Observability

**Requirements:**

- Replace all console.log with LogTape structured logging
- Metrics
- Traces
- OTEL Collector container in compose stack
- Minimum debug/file export backend

---

### FR-5: Docker Compose Deployment

**Requirements:**

- Single docker compose up starts all services
- Health checks on all services
- Example services included
- OTEL Collector container included
- Documented config variables
- Multi-arch images for x86_64 and ARM64

---

## 8. Non-Functional Requirements

- Self-contained with no external service dependencies beyond container runtime
- Small footprint with hardware floor of Raspberry Pi 5 (8GB RAM, ARM64) or equivalent x86_64 hardware

---

## 9. Risks & Mitigations

| Risk                                 | Mitigation                                                                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Target of the right minimum hardware | Refine a set of metrics once model is proven                                                                                                |
| Slow or not present feedback loop    | Maintain tight loop with BD and communicating the value prop and what we are building                                                       |
| Investment                           | This is our strategic bet, work on the feedback loop                                                                                        |
| Migration of Mochicake               | Document full features of Catalyst V1, create a low friction migration plan, but okay with focus on general principles w/o straying too far |

---

**End of Document**
