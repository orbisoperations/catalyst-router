# PKI Documentation

Documentation for the Catalyst PKI (Public Key Infrastructure) system, which
provides X.509 certificate-based identity and mTLS for all inter-service
communication.

## Documents

### Background and Concepts

| Document                                | Audience                 | Description                                                    |
| :-------------------------------------- | :----------------------- | :------------------------------------------------------------- |
| [PKI Primer](pki-primer.md)             | Developers new to PKI    | What is PKI? Certificates, CAs, chain of trust, mTLS, CSRs.    |
| [SPIFFE Primer](spiffe-primer.md)       | Developers new to SPIFFE | What is SPIFFE? URI-based identity, X.509-SVID, trust domains. |
| [Bun TLS Cookbook](bun-tls-cookbook.md) | All developers           | How to use certificates with Bun.serve() and fetch().          |

### Architecture and Design

| Document                                                          | Audience      | Description                                                    |
| :---------------------------------------------------------------- | :------------ | :------------------------------------------------------------- |
| [ADR 0011](../adr/0011-pki-hierarchy-and-certificate-profiles.md) | All engineers | CA hierarchy, SPIFFE scheme, certificate profiles, revocation. |
| [ADR 0007](../adr/0007-certificate-bound-access-tokens.md)        | All engineers | Certificate-bound access tokens (RFC 8705) for peering.        |

### Operations and Implementation

| Document                                      | Audience                | Description                                               |
| :-------------------------------------------- | :---------------------- | :-------------------------------------------------------- |
| [Interaction Flows](interaction-flows.md)     | Implementors, operators | Step-by-step sequences for all 14 PKI flows.              |
| [Operations Guide](operations-guide.md)       | Operators, SREs         | Troubleshooting, procedures, CLI cheat sheet, monitoring. |
| [Implementation Plan](implementation-plan.md) | Implementors            | File-by-file build plan for `packages/pki`.               |

### Package Documentation

| Document                                            | Audience   | Description                        |
| :-------------------------------------------------- | :--------- | :--------------------------------- |
| [packages/pki README](../../packages/pki/README.md) | Developers | Public API, usage examples, tests. |

## Reading Order

If you are new to this system, read the documents in this order:

1. **[PKI Primer](pki-primer.md)** -- Understand certificates and CAs.
2. **[SPIFFE Primer](spiffe-primer.md)** -- Understand SPIFFE identity.
3. **[ADR 0011](../adr/0011-pki-hierarchy-and-certificate-profiles.md)** -- Catalyst's specific design.
4. **[Bun TLS Cookbook](bun-tls-cookbook.md)** -- Practical code.
5. **[Interaction Flows](interaction-flows.md)** -- How the pieces connect.
6. **[Operations Guide](operations-guide.md)** -- Day-to-day operations.
