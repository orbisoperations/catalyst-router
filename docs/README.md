# Catalyst Router Documentation

This directory contains the technical documentation for Catalyst Router.
For the project overview and quickstart, see the [[README|README]] at the repository root.

## Documentation Map

### Architecture

- [[overview|System Architecture]] — Core Pod model, package map, data flows, authorization
- [[api-design|API Design]] — Capnweb progressive API pattern, transport layer, REST comparison
- [[jwt-design|JWT/JWKS Design]] — Token lifecycle, key management, JWKS
- [[tech-stack|Technology Stack]] — Runtime, frameworks, and tooling choices
- [[crosswalk|Project Crosswalk]] — Mapping between project objectives

### Protocols

- [[bgp-protocol|BGP Service Discovery]] — BGP-inspired L4-7 routing protocol
- [[internal-peering|Internal Peering]] — Peer-to-peer route exchange architecture

### API Reference

- [[cli|CLI Reference]] — Command-line interface documentation
- [[sdk|SDK Reference]] — External SDK documentation

### Architecture Decision Records

- [[docs/adr/README|ADR Index]] — All architecture decision records (ADR-0001 through ADR-0010)

### Product Requirements

- [[doc|PRD 01]] — Initial product requirements document
- [[progress|PRD 01 Progress]] — Implementation progress tracking

### Planning

- [[milestone|Milestones]] — Implementation milestones
- [[rfi|RFI]] — Request for information / advanced requirements

## Root-Level Documents

These files live at the repository root per GitHub conventions:

- [[README|README]] — Project overview and quickstart
- [LICENSE](../LICENSE) — Commons Clause + Elastic License 2.0
- [[LICENSE_HUMAN_READABLE|License Summary]] — Human-readable license summary
- [[CONTRIBUTING|Contributing]] — How to contribute
- [[CLA]] — Contributor License Agreement
- [[SECURITY|Security]] — Peer security protocol
- [[constitution|Constitution]] — Architectural principles and governance
