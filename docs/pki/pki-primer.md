# PKI Primer

This document explains Public Key Infrastructure (PKI) for developers who have
not worked with certificates, CAs, or mTLS before. It covers the concepts that
underpin the Catalyst PKI system described in
[ADR 0011](../adr/0011-pki-hierarchy-and-certificate-profiles.md).

---

## Table of Contents

1. [The Problem PKI Solves](#1-the-problem-pki-solves)
2. [Public and Private Keys](#2-public-and-private-keys)
3. [What is a Certificate?](#3-what-is-a-certificate)
4. [Certificate Authorities](#4-certificate-authorities)
5. [Chain of Trust](#5-chain-of-trust)
6. [Intermediate CAs](#6-intermediate-cas)
7. [TLS and mTLS](#7-tls-and-mtls)
8. [Certificate Signing Requests](#8-certificate-signing-requests)
9. [Certificate Lifecycle](#9-certificate-lifecycle)
10. [Short-Lived Certificates and Revocation](#10-short-lived-certificates-and-revocation)
11. [How Catalyst Uses PKI](#11-how-catalyst-uses-pki)

---

## 1. The Problem PKI Solves

When two services communicate over a network, they need answers to two
questions:

1. **Identity:** "Am I actually talking to Service B, or to an impersonator?"
2. **Confidentiality:** "Can anyone else read the data I am sending?"

A shared password (pre-shared key) answers the first question weakly -- it
proves the other side _knows_ a secret, but not _who_ they are. If the password
leaks, everyone with it can impersonate any participant.

PKI solves both problems using asymmetric cryptography. Each participant holds
a unique key pair and a certificate that binds their identity to their public
key. A trusted third party (the Certificate Authority) vouches for the binding.

---

## 2. Public and Private Keys

Asymmetric cryptography uses a pair of mathematically related keys:

```
+--------------+          +--------------+
| Private Key  |          | Public Key   |
|              |          |              |
| - Keep       |          | - Share with |
|   secret     | <------> |   everyone   |
| - Sign data  |          | - Verify     |
| - Decrypt    |          |   signatures |
|              |          | - Encrypt    |
+--------------+          +--------------+
```

**Private key:** Only the owner holds it. Used to sign data (prove identity)
and decrypt messages.

**Public key:** Freely distributed. Used to verify signatures (confirm the
signer) and encrypt messages that only the private key holder can decrypt.

The crucial property: **data signed with the private key can be verified by
anyone with the public key**, but the private key cannot be derived from the
public key.

Catalyst uses ECDSA P-384 (a 384-bit elliptic curve) for all key pairs.

---

## 3. What is a Certificate?

A certificate is a signed document that binds a public key to an identity.
Think of it as a digital ID card:

```
+-----------------------------------------------+
|              X.509 Certificate                 |
|-----------------------------------------------|
| Subject:     CN=node-a.example.com             |
| Issuer:      CN=Catalyst Services CA           |
| Validity:    2026-02-13 09:00 to 10:00 UTC     |
| Public Key:  [ECDSA P-384 public key]          |
| Serial:      A1B2C3D4                          |
|                                                |
| Extensions:                                    |
|   SAN (URI): spiffe://example.com/orch/node-a  |
|   Key Usage: digitalSignature                  |
|   EKU:       serverAuth, clientAuth            |
|                                                |
| Signature:   [signed by Catalyst Services CA]  |
+-----------------------------------------------+
```

Key fields:

- **Subject:** Who the certificate identifies (a Common Name or CN).
- **Issuer:** Who signed (vouched for) this certificate.
- **Validity:** The time window during which the certificate is valid.
- **Public Key:** The subject's public key.
- **Extensions:** Additional metadata like Subject Alternative Names (SANs),
  which can include DNS names, IP addresses, or URIs (like SPIFFE IDs).
- **Signature:** The issuer's cryptographic signature over all of the above,
  proving the issuer approved this certificate.

Certificates use the X.509 v3 standard and are typically stored in PEM format
(base64-encoded, wrapped in `-----BEGIN CERTIFICATE-----` / `-----END
CERTIFICATE-----` markers).

---

## 4. Certificate Authorities

A **Certificate Authority (CA)** is the trusted entity that signs certificates.
The CA's own certificate is called the **root certificate** and its private key
is the **root key**.

```
+---------------------------+
|     Certificate Authority |
|---------------------------|
| Root Certificate:         |
|   Subject: Catalyst Root  |
|   Issuer:  Catalyst Root  |  <-- Self-signed
|   Public Key: [...]       |
|   Signature: [self-sig]   |
|                           |
| Root Private Key:         |
|   [KEPT OFFLINE/SECURE]   |
+---------------------------+
         |
         |  Signs
         v
+---------------------------+
|   Service Certificate     |
|---------------------------|
| Subject: node-a.example   |
| Issuer:  Catalyst Root    |
| Signature: [by Root CA]   |
+---------------------------+
```

The root certificate is **self-signed** -- its issuer is itself. This is the
anchor of trust. Everyone who trusts this root CA will accept any certificate
signed by it.

**Why trust works:** If you pre-install the root CA's certificate in your trust
store, you can verify that any certificate claiming to be signed by that CA
actually was. The root's public key verifies the signature on the child
certificate.

---

## 5. Chain of Trust

Verification walks a chain from the certificate being checked back to a
trusted root:

```
1. Receive service certificate from peer
2. Look at the "Issuer" field
3. Find the issuer's certificate (the CA cert)
4. Use the CA's public key to verify the signature on the service cert
5. If the CA cert is the root (self-signed), and we trust it, we are done
6. If not, repeat from step 2 with the CA cert itself
```

Every certificate in the chain must be valid (not expired, not revoked).

**Trust stores:** Operating systems, browsers, and applications maintain a list
of root CA certificates they trust. In Catalyst, each service loads a trust
bundle (a set of CA certificates) that defines which roots and intermediates
it accepts.

---

## 6. Intermediate CAs

In practice, the root CA's private key is too important to use for signing
day-to-day certificates. If it were compromised, the entire PKI collapses.

The solution is **intermediate CAs**: CAs that are signed by the root but
do the actual certificate signing work.

```
+============================+
|       Root CA              |
|  (offline, air-gapped)     |
|  Validity: 10 years        |
+============================+
       |              |
+======+=====+  +=====+======+
| Services   |  | Transport  |
| CA         |  | CA         |
| (online)   |  | (online)   |
| Validity:  |  | Validity:  |
|   2 years  |  |   2 years  |
+=============  =============+
   |  |  |          |    |
  service        envoy
  certs          certs
  (1 hour)       (1 hour)
```

**Why intermediates?**

- **Limit blast radius:** If an intermediate CA is compromised, only the
  certificates under it are affected. The root can sign a new intermediate
  and the system recovers. If the root itself were compromised, everything
  must be rebuilt.
- **Separation of concerns:** Different intermediates can serve different
  purposes. Catalyst uses one for control-plane services and another for
  data-plane (Envoy) traffic, so a compromise in one domain does not grant
  access to the other.
- **Operational convenience:** The root key stays offline (on a USB drive,
  in an HSM). Intermediates are "online" and can sign certificates
  automatically.

**Path length constraints:** The root CA has `pathlen:1`, meaning it can sign
CAs one level below it (intermediates). The intermediates have `pathlen:0`,
meaning they cannot sign other CAs -- only end-entity certificates. This
prevents unauthorized creation of new CAs.

---

## 7. TLS and mTLS

**TLS (Transport Layer Security)** is the protocol that encrypts network
connections. When you connect to a website over `https://`, TLS is at work.

In standard TLS, only the server proves its identity:

```
Client                           Server
  |                                |
  |--- TLS ClientHello ---------->|
  |<-- TLS ServerHello -----------|
  |<-- Server Certificate -------|  "Here is my cert"
  |                                |
  | Client verifies:               |
  |   - Cert chain valid?          |
  |   - CN/SAN matches hostname?   |
  |   - Not expired?               |
  |                                |
  |--- Key Exchange ------------->|
  |<-- Encrypted channel ------->|
```

**mTLS (mutual TLS)** adds client authentication: both sides present
certificates and both verify each other:

```
Client                           Server
  |                                |
  |--- TLS ClientHello ---------->|
  |<-- TLS ServerHello -----------|
  |<-- Server Certificate -------|
  |<-- CertificateRequest -------|  "Show me YOUR cert too"
  |--- Client Certificate ------>|  "Here is mine"
  |                                |
  | Both sides verify:             |
  |   - Peer's cert chain valid?   |
  |   - Identity matches expected? |
  |   - Not expired?               |
  |                                |
  |<-- Encrypted channel -------->|
```

mTLS provides strong mutual authentication: both client and server know
exactly who they are talking to, verified by cryptographic proof.

Catalyst uses mTLS for:

- Orchestrator-to-orchestrator peering (orchestrator mesh)
- Control-plane service communication (auth, node, gateway)
- Envoy proxy-to-proxy traffic (envoy mesh)

---

## 8. Certificate Signing Requests

When a service needs a certificate, it does not send its private key to the
CA. Instead, it sends a **Certificate Signing Request (CSR)**:

```
Service                          CA
  |                                |
  | 1. Generate key pair locally   |
  |    (private key stays here)    |
  |                                |
  | 2. Build CSR:                  |
  |    - Public key                |
  |    - Requested identity (CN)   |
  |    - Requested SANs            |
  |    - Self-signature            |
  |      (proof of private key)    |
  |                                |
  | 3. Send CSR ----------------->|
  |                                |
  |              4. CA validates:   |
  |                 - CSR signature |
  |                 - Identity OK   |
  |                 - Policy check  |
  |                                |
  |              5. CA signs cert:  |
  |                 - Sets validity |
  |                 - Adds SAN      |
  |                 - Signs with    |
  |                   CA private key|
  |                                |
  | 6. Receive signed cert <------|
  |    + CA certificate chain      |
  |                                |
```

**The private key never leaves the service.** The CSR contains only the
public key plus a self-signature that proves the requester holds the
corresponding private key (proof of possession).

---

## 9. Certificate Lifecycle

Certificates have a defined lifecycle:

```
  Generate      Issue       Use          Renew       Expire
  key pair   (sign CSR)   (mTLS)     (new CSR)     (invalid)
     |           |          |            |             |
     v           v          v            v             v
  [keygen] -> [CSR] -> [active] -> [renewing] -> [expired]
                                       |
                                       v
                                   [new cert active]
                                   [old cert expires naturally]
```

1. **Generation:** The service creates a fresh key pair.
2. **Issuance:** A CSR is submitted to the CA. The CA validates the request
   and signs a certificate with a defined validity period.
3. **Active use:** The certificate is loaded into the service's TLS
   configuration. Peers verify it during TLS handshakes.
4. **Renewal:** Before the certificate expires, the service generates a new
   key pair, builds a new CSR, and requests a fresh certificate. The old and
   new certificates overlap briefly.
5. **Expiration:** The certificate's `notAfter` time passes. Any peer that
   checks the validity will reject it.

---

## 10. Short-Lived Certificates and Revocation

Traditional PKI issues certificates valid for months or years. If a
certificate is compromised, you need a **revocation** mechanism:

- **CRL (Certificate Revocation List):** The CA publishes a list of revoked
  serial numbers. Clients must download and check this list.
- **OCSP (Online Certificate Status Protocol):** Clients ask the CA in
  real-time whether a specific certificate is still valid.

Both add complexity, latency, and failure modes. OCSP goes down? Your
services cannot verify certificates.

**Short-lived certificates** (Catalyst default: 1 hour) eliminate this
problem. If a certificate is compromised:

1. The CA stops issuing new certificates for that identity.
2. The existing certificate expires naturally within 1 hour.
3. No CRL or OCSP infrastructure is needed.

The tradeoff is that the CA must be available for frequent renewals
(every 30 minutes at the default 50% lifetime renewal trigger).

---

## 11. How Catalyst Uses PKI

Catalyst's PKI system builds on all of these concepts:

- **Two-tier CA hierarchy:** A Root CA (offline, 10-year validity) signs two
  intermediate CAs -- a Services CA for control-plane services and a
  Transport CA for Envoy proxies.
- **SPIFFE identities:** Each certificate carries a URI SAN in SPIFFE format
  (e.g., `spiffe://example.com/orchestrator/node-a`) that uniquely identifies
  the service. See the [SPIFFE Primer](spiffe-primer.md).
- **Short-lived SVIDs:** End-entity certificates default to 1-hour validity,
  renewed automatically at 50% lifetime.
- **CSR-based issuance:** Services generate their own key pairs and submit
  CSRs to the auth service, which acts as the CA.
- **Passive revocation:** Denied identities cannot renew; their certificates
  expire naturally.

For the full architecture, see [ADR 0011](../adr/0011-pki-hierarchy-and-certificate-profiles.md).
For operational procedures, see the [Operations Guide](operations-guide.md).
For Bun-specific TLS code examples, see the [Bun TLS Cookbook](bun-tls-cookbook.md).
