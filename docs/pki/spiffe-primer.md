# SPIFFE Primer

This document explains the SPIFFE identity framework and how Catalyst uses it.
It is a companion to [ADR 0011](../adr/0011-pki-hierarchy-and-certificate-profiles.md),
which defines the full SPIFFE URI scheme and certificate profiles.

If you are new to PKI concepts (certificates, CAs, chain of trust), start
with the [PKI Primer](pki-primer.md) first.

---

## Table of Contents

1. [The Problem SPIFFE Solves](#1-the-problem-spiffe-solves)
2. [What is SPIFFE?](#2-what-is-spiffe)
3. [SPIFFE IDs](#3-spiffe-ids)
4. [X.509-SVID](#4-x509-svid)
5. [Trust Domains](#5-trust-domains)
6. [How Catalyst Uses SPIFFE](#6-how-catalyst-uses-spiffe)
7. [SPIFFE vs Traditional CN-Based Identity](#7-spiffe-vs-traditional-cn-based-identity)
8. [Further Reading](#8-further-reading)

---

## 1. The Problem SPIFFE Solves

In traditional TLS, services are identified by hostname. A certificate for
`node-a.example.com` is verified by checking that the DNS SAN or CN matches
the hostname the client connected to.

This works for static infrastructure, but breaks down in dynamic environments:

- **Containers** get ephemeral hostnames and IP addresses.
- **Multiple services** may run on the same host.
- **Service identity** is not the same as hostname -- an orchestrator and
  an auth service on the same node need distinct identities.
- **Cross-cluster communication** needs identity that is meaningful across
  network boundaries, not tied to DNS.

SPIFFE provides a standard way to assign and verify **workload identity**
independent of network location.

---

## 2. What is SPIFFE?

**SPIFFE** (Secure Production Identity Framework for Everyone) is a set of
open standards for workload identity:

- **SPIFFE ID:** A URI that uniquely identifies a workload.
- **SVID (SPIFFE Verifiable Identity Document):** A cryptographic document
  (X.509 certificate or JWT) that proves a workload holds a specific
  SPIFFE ID.
- **Trust Bundle:** A set of root certificates that define which CAs are
  trusted for a given trust domain.

SPIFFE is an open specification maintained by the CNCF. It is implemented
by projects like SPIRE (the SPIFFE Runtime Environment) and is supported
natively by Envoy for service mesh identity.

Catalyst implements the SPIFFE identity scheme directly in its PKI system,
without requiring SPIRE. This provides SPIFFE compatibility while keeping
the deployment simple.

---

## 3. SPIFFE IDs

A SPIFFE ID is a URI with the scheme `spiffe://`:

```
spiffe://<trust-domain>/<path>
```

- **Trust domain:** An organizational boundary, typically a registered
  domain name (e.g., `acme.catalyst.io`).
- **Path:** Identifies the specific workload within the trust domain.

Examples:

```
spiffe://acme.catalyst.io/orchestrator/node-a.prod.acme.io
spiffe://acme.catalyst.io/auth/auth-a
spiffe://acme.catalyst.io/envoy/app/node-a.prod.acme.io
spiffe://acme.catalyst.io/gateway/gateway-a
```

SPIFFE IDs have no port, no query parameters, no fragment. They are pure
identity URIs.

---

## 4. X.509-SVID

An **X.509-SVID** is a standard X.509 certificate that carries a SPIFFE ID
in its Subject Alternative Name (SAN) URI extension:

```
+-----------------------------------------------+
|              X.509-SVID                        |
|-----------------------------------------------|
| Subject:     CN=node-a.prod.acme.io            |
| Issuer:      CN=Catalyst Services CA           |
|                                                |
| Subject Alternative Names:                     |
|   URI: spiffe://acme.catalyst.io/orch/node-a   |  <-- SPIFFE ID
|   DNS: node-a.prod.acme.io                     |  <-- backward compat
|                                                |
| Key Usage:   digitalSignature                  |
| EKU:         serverAuth, clientAuth            |
| Validity:    1 hour                            |
+-----------------------------------------------+
```

Per the X.509-SVID specification:

- Each certificate contains exactly **one** SPIFFE URI SAN.
- The SPIFFE URI is the **authoritative identity**. DNS SANs may be included
  for backward compatibility but are not the primary identity.
- The certificate must chain to a root CA whose certificate is in the
  peer's trust bundle.

When two services connect via mTLS, they extract the SPIFFE ID from each
other's certificate and use it for authorization decisions (e.g., "is
`spiffe://.../orchestrator/node-a` allowed to perform IBGP_CONNECT?").

---

## 5. Trust Domains

A **trust domain** is the scope within which SPIFFE IDs are meaningful.
All workloads in the same trust domain share the same root CA (or set of
root CAs) and can verify each other's certificates.

```
Trust Domain: acme.catalyst.io
Root CA: Acme Corp Catalyst Root CA
  |
  +-- spiffe://acme.catalyst.io/orchestrator/node-a    (valid)
  +-- spiffe://acme.catalyst.io/auth/auth-a            (valid)
  +-- spiffe://partner.example.com/orchestrator/x      (foreign domain)
```

A certificate with a SPIFFE ID from a foreign trust domain is only accepted
if the local node has explicitly added that foreign domain's root CA to its
trust bundle. This is the basis for **federation** between organizations.

Trust domains should use registered domain suffixes (not `.local`, which
conflicts with mDNS). The default `catalyst.example.com` is for development
and testing only.

---

## 6. How Catalyst Uses SPIFFE

Catalyst's SPIFFE path scheme encodes service type and instance identity:

```
spiffe://<trust-domain>/<service-type>/<instance-id>
```

| Path Segment 1    | Segment 2   | Description                          |
| :---------------- | :---------- | :----------------------------------- |
| `orchestrator`    | `{node-id}` | Orchestrator service on a named node |
| `auth`            | `{inst-id}` | Auth service instance                |
| `node`            | `{node-id}` | Node service (plugin host)           |
| `gateway`         | `{inst-id}` | GraphQL gateway instance             |
| `envoy/app`       | `{node-id}` | Envoy application proxy (L7)         |
| `envoy/transport` | `{node-id}` | Envoy transport proxy (inter-node)   |

The service type determines which CA signs the certificate:

- `orchestrator`, `auth`, `node`, `gateway` -- signed by the **Services CA**
- `envoy/app`, `envoy/transport` -- signed by the **Transport CA**

This separation means a compromise of a Transport CA certificate does not
grant access to control-plane APIs, and vice versa.

The `@catalyst/pki` package provides utilities for working with SPIFFE IDs:

```typescript
import { parseSpiffeId, buildSpiffeId, isValidSpiffeId } from '@catalyst/pki'

// Build a SPIFFE ID
const id = buildSpiffeId('acme.catalyst.io', 'orchestrator', 'node-a.prod.acme.io')
// => 'spiffe://acme.catalyst.io/orchestrator/node-a.prod.acme.io'

// Parse a SPIFFE ID into components
const parsed = parseSpiffeId('spiffe://acme.catalyst.io/auth/auth-a')
// => { uri: 'spiffe://...', trustDomain: 'acme.catalyst.io', serviceType: 'auth', instanceId: 'auth-a' }

// Validate
isValidSpiffeId('spiffe://acme.catalyst.io/orchestrator/node-a') // true
isValidSpiffeId('https://example.com') // false
```

---

## 7. SPIFFE vs Traditional CN-Based Identity

| Aspect                 | Traditional CN-Based             | SPIFFE URI-Based                     |
| :--------------------- | :------------------------------- | :----------------------------------- |
| Identity format        | `CN=node-a.example.com`          | `spiffe://example.com/orch/node-a`   |
| Hostname dependent     | Yes (CN must match DNS)          | No (URI is independent of hostname)  |
| Multiple services/host | Awkward (different CNs per cert) | Natural (different path per service) |
| Cross-cluster          | Requires shared DNS              | Trust domain federation              |
| Envoy/service mesh     | Not natively supported           | Native SDS and RBAC support          |
| Authorization          | Based on hostname patterns       | Based on structured identity paths   |
| Specificity            | One name per cert (usually)      | Structured type/instance hierarchy   |

The SPIFFE URI approach makes identity a first-class concept separate from
network addressing. This is particularly valuable in Catalyst where multiple
services run on the same node, services move between hosts, and authorization
decisions depend on the service's role, not its hostname.

---

## 8. Further Reading

- [ADR 0011: PKI Hierarchy and Certificate Profiles](../adr/0011-pki-hierarchy-and-certificate-profiles.md) --
  The full specification of Catalyst's SPIFFE scheme, CA hierarchy, and
  certificate profiles.
- [SPIFFE specification](https://spiffe.io/docs/latest/spiffe-about/overview/) --
  The official SPIFFE documentation.
- [X.509-SVID specification](https://github.com/spiffe/spiffe/blob/main/standards/X509-SVID.md) --
  How SPIFFE IDs are encoded in X.509 certificates.
- [PKI Primer](pki-primer.md) -- Background on certificates, CAs, and
  chain of trust.
- [Bun TLS Cookbook](bun-tls-cookbook.md) -- How to use certificates with
  Bun's TLS APIs.
