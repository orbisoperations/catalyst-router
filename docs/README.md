# Catalyst Router Documentation

This directory contains the technical documentation for Catalyst Router.
For the project overview and quickstart, see the [README](../README.md) at the repository root.

## Documentation Map

### Architecture

- [System Architecture](./architecture/overview.md) — Core Pod model, package map, data flows, authorization
- [API Design](./api/api-design.md) — Capnweb progressive API pattern, transport layer, REST comparison
- [JWT/JWKS Design](./architecture/jwt-design.md) — Token lifecycle, key management, JWKS
- [Technology Stack](./architecture/tech-stack.md) — Runtime, frameworks, and tooling choices
- [Project Crosswalk](./architecture/crosswalk.md) — Mapping between project objectives

### Protocols

- [BGP Service Discovery](./protocols/bgp-protocol.md) — BGP-inspired L4-7 routing protocol
- [Internal Peering](./protocols/internal-peering.md) — Peer-to-peer route exchange architecture

### API Reference

- [CLI Reference](./api/cli.md) — Command-line interface documentation
- [SDK Reference](./api/sdk.md) — External SDK documentation

### Architecture Decision Records

- [ADR Index](./adr/README.md) — All architecture decision records (ADR-0001 through ADR-0010)

### Product Requirements

- [PRD 01](./prd/01/doc.md) — Initial product requirements document
- [PRD 01 Progress](./prd/01/progress.md) — Implementation progress tracking

### Planning

- [Milestones](./planning/milestone.md) — Implementation milestones
- [RFI](./planning/rfi.md) — Request for information / advanced requirements

## Root-Level Documents

These files live at the repository root per GitHub conventions:

- [README](../README.md) — Project overview and quickstart
- [LICENSE](../LICENSE) — Commons Clause + Elastic License 2.0
- [License Summary](../LICENSE_HUMAN_READABLE.md) — Human-readable license summary
- [Contributing](../CONTRIBUTING.md) — How to contribute
- [CLA](../CLA.md) — Contributor License Agreement
- [Security](../SECURITY.md) — Peer security protocol
- [Constitution](../constitution.md) — Architectural principles and governance
