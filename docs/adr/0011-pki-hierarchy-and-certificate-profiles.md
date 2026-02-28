# ADR 0011: PKI Hierarchy, Certificate Profiles, and SPIFFE Identity Scheme

## Status

Proposed

## Context

Catalyst is a distributed system of cooperating nodes, each running an
orchestrator, auth service, envoy service, and envoy proxy. Nodes peer with
each other over WebSocket (orchestrator mesh) and route application traffic
through Envoy proxies (envoy mesh). Today, inter-node authentication uses
JWT bearer tokens with optional certificate binding (ADR 0007), but the
underlying certificate infrastructure -- the CA hierarchy, identity scheme,
certificate profiles, and lifecycle -- has not been formally defined.

This ADR establishes the PKI foundation that all certificate-based identity
in Catalyst is built upon.

### Design principles

1. **Short-lived certificates preferred over revocation complexity.**
   End-entity certificates live hours, not years.
2. **SPIFFE-compatible identities** so that Envoy SDS, future SPIRE
   integration, and cross-system federation have a standard identity format.
3. **Complete separation of PKI CA keys from JWT signing keys.**
   The X.509 CA hierarchy and the JWT `ES384` key manager
   (`PersistentLocalKeyManager`) are independent trust domains with
   independent key material.
4. **Two-tier CA hierarchy** -- deep enough for operational flexibility,
   shallow enough to reason about.

## Decision

### 1. Trust Domain and SPIFFE URI Scheme

The SPIFFE trust domain is the organizational boundary for Catalyst.
Per the SPIFFE specification, trust domains should use registered domain
suffixes (not `.local` which conflicts with mDNS). The default trust
domain is configurable:

```
spiffe://catalyst.example.com
```

Operators MUST configure their own registered domain (e.g.,
`spiffe://acme.catalyst.io`, `spiffe://corp.example.com`). The
`catalyst.example.com` default is for development and testing only.

The path component encodes service type and instance identity:

```
spiffe://<trust-domain>/<service-type>/<instance-id>

Examples:
  spiffe://catalyst.example.com/orchestrator/node-a.somebiz.local.io
  spiffe://catalyst.example.com/auth/auth-a
  spiffe://catalyst.example.com/envoy/app/node-a.somebiz.local.io
  spiffe://catalyst.example.com/envoy/transport/node-a.somebiz.local.io
  spiffe://catalyst.example.com/node/node-a.somebiz.local.io
```

**Path conventions:**

| Segment 1         | Segment 2   | Segment 3 | Description                                 |
| :---------------- | :---------- | :-------- | :------------------------------------------ |
| `orchestrator`    | `{node-id}` | --        | Orchestrator service on a named node        |
| `auth`            | `{inst-id}` | --        | Auth service instance                       |
| `node`            | `{node-id}` | --        | Node service (plugin host)                  |
| `envoy/app`       | `{node-id}` | --        | Envoy application proxy (L7 data plane)     |
| `envoy/transport` | `{node-id}` | --        | Envoy transport proxy (inter-node QUIC/TCP) |
| `gateway`         | `{inst-id}` | --        | GraphQL gateway instance                    |

The `{node-id}` value is the FQDN-style identifier already used by the
system (e.g., `node-a.somebiz.local.io`). The `{inst-id}` is the
container/process identifier (e.g., `auth-a`, `gateway-a`).

Per the X.509-SVID specification, each certificate contains exactly ONE
SPIFFE URI SAN. Additional DNS SANs may be included for backward
compatibility but the SPIFFE URI is the authoritative identity.

### 2. PKI Hierarchy

```
                    +===========================+
                    |       Catalyst Root CA     |
                    |  (offline, air-gapped)     |
                    |  CN: Catalyst Root CA      |
                    |  Validity: 10 years        |
                    |  Key: EC P-384             |
                    +===========================+
                           |              |
              +============+==+    +==+============+
              |  Services CA  |    |  Transport CA  |
              |  (online)     |    |  (online)      |
              |  Validity:    |    |  Validity:     |
              |    2 years    |    |    2 years     |
              |  Key: EC P-384|    |  Key: EC P-384 |
              +===============+    +================+
                /    |    \               |       \
           +---+ +---+ +----+       +----+   +-----+
           |   | |   | |    |       |    |   |     |
          orch auth node gw     envoy/app envoy/transport
          leaf leaf leaf leaf    leaf         leaf
```

**Why two intermediate CAs:**

- **Services CA** issues certificates to Catalyst control-plane services
  (orchestrator, auth, node, gateway). These certificates are used for
  service-to-service mTLS within a stack's control network and for
  orchestrator-mesh peering.
- **Transport CA** issues certificates to Envoy proxies. These
  certificates are used for Envoy-to-Envoy mTLS on the data plane
  (envoy-mesh network). Separating transport from services means a
  compromise of an Envoy proxy certificate does not grant access to
  the control-plane auth or orchestrator APIs.

Both intermediates are signed by the same root, so cross-verification
is possible when needed (e.g., orchestrator validating an Envoy SDS
request), but the default trust scope for each network segment is
restricted to the appropriate intermediate.

### 3. Certificate Profiles

#### 3.1 Root CA

| Field               | Value                        |
| :------------------ | :--------------------------- |
| Subject CN          | `Catalyst Root CA`           |
| Key algorithm       | ECDSA P-384 (secp384r1)      |
| Signature algorithm | ecdsa-with-SHA384            |
| Validity            | 10 years                     |
| Basic Constraints   | `CA:TRUE, pathlen:1`         |
| Key Usage           | `keyCertSign, cRLSign`       |
| Subject Key ID      | derived from public key hash |
| Storage             | Offline / air-gapped / HSM   |

#### 3.2 Services Intermediate CA

| Field             | Value                                                                                                                                                                                            |
| :---------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subject CN        | `Catalyst Services CA`                                                                                                                                                                           |
| Key algorithm     | ECDSA P-384                                                                                                                                                                                      |
| Validity          | 2 years                                                                                                                                                                                          |
| Basic Constraints | `CA:TRUE, pathlen:0`                                                                                                                                                                             |
| Key Usage         | `keyCertSign, cRLSign`                                                                                                                                                                           |
| Name Constraints  | Permitted: `URI:spiffe://catalyst.example.com/orchestrator/`, `URI:spiffe://catalyst.example.com/auth/`, `URI:spiffe://catalyst.example.com/node/`, `URI:spiffe://catalyst.example.com/gateway/` |
| AKI               | Root CA SKI                                                                                                                                                                                      |

#### 3.3 Transport Intermediate CA

| Field             | Value                                                 |
| :---------------- | :---------------------------------------------------- |
| Subject CN        | `Catalyst Transport CA`                               |
| Key algorithm     | ECDSA P-384                                           |
| Validity          | 2 years                                               |
| Basic Constraints | `CA:TRUE, pathlen:0`                                  |
| Key Usage         | `keyCertSign, cRLSign`                                |
| Name Constraints  | Permitted: `URI:spiffe://catalyst.example.com/envoy/` |
| AKI               | Root CA SKI                                           |

#### 3.4 Orchestrator End-Entity Certificate

| Field              | Value                                                  |
| :----------------- | :----------------------------------------------------- |
| Subject CN         | `{node-id}` (e.g., `node-a.somebiz.local.io`)          |
| SAN (URI)          | `spiffe://catalyst.example.com/orchestrator/{node-id}` |
| SAN (DNS)          | `{node-id}`, `orch-{short-name}` (container alias)     |
| Key algorithm      | ECDSA P-384                                            |
| Validity           | 1 hour (default; configurable up to 24h)               |
| Basic Constraints  | `CA:FALSE`                                             |
| Key Usage          | `digitalSignature`                                     |
| Extended Key Usage | `serverAuth, clientAuth`                               |
| Issuer             | Services CA                                            |

**Notes:** Both `serverAuth` and `clientAuth` are required because
orchestrators act as both server (accepting incoming peer connections
on the orchestrator-mesh) and client (initiating outbound peer
connections). The SPIFFE URI is the authoritative identity; DNS SANs
are included for backward compatibility with non-SPIFFE-aware TLS
clients.

#### 3.5 Auth Service End-Entity Certificate

| Field              | Value                                              |
| :----------------- | :------------------------------------------------- |
| Subject CN         | `{instance-id}` (e.g., `auth-a`)                   |
| SAN (URI)          | `spiffe://catalyst.example.com/auth/{instance-id}` |
| SAN (DNS)          | `auth` (stack-internal alias), `{instance-id}`     |
| Key algorithm      | ECDSA P-384                                        |
| Validity           | 1 hour (default; configurable up to 24h)           |
| Basic Constraints  | `CA:FALSE`                                         |
| Key Usage          | `digitalSignature`                                 |
| Extended Key Usage | `serverAuth, clientAuth`                           |
| Issuer             | Services CA                                        |

**Notes:** The auth service is a server (accepting RPC from
orchestrator) and a client (when participating in distributed token
validation across nodes). The `auth` DNS alias matches the
stack-internal network alias used in docker-compose.

#### 3.6 Node Service End-Entity Certificate

| Field              | Value                                          |
| :----------------- | :--------------------------------------------- |
| Subject CN         | `{node-id}`                                    |
| SAN (URI)          | `spiffe://catalyst.example.com/node/{node-id}` |
| SAN (DNS)          | `{node-id}`                                    |
| Key algorithm      | ECDSA P-384                                    |
| Validity           | 1 hour (default; configurable up to 24h)       |
| Basic Constraints  | `CA:FALSE`                                     |
| Key Usage          | `digitalSignature`                             |
| Extended Key Usage | `serverAuth, clientAuth`                       |
| Issuer             | Services CA                                    |

#### 3.7 Gateway End-Entity Certificate

| Field              | Value                                                 |
| :----------------- | :---------------------------------------------------- |
| Subject CN         | `{instance-id}` (e.g., `gateway-a`)                   |
| SAN (URI)          | `spiffe://catalyst.example.com/gateway/{instance-id}` |
| SAN (DNS)          | `{instance-id}`                                       |
| Key algorithm      | ECDSA P-384                                           |
| Validity           | 1 hour (default; configurable up to 24h)              |
| Basic Constraints  | `CA:FALSE`                                            |
| Key Usage          | `digitalSignature`                                    |
| Extended Key Usage | `serverAuth`                                          |
| Issuer             | Services CA                                           |

**Notes:** Gateway is server-only (accepts GraphQL queries and
subscriptions from clients). It does not initiate outbound mTLS
connections, so `clientAuth` is omitted.

#### 3.8 Envoy Application Proxy End-Entity Certificate

| Field              | Value                                               |
| :----------------- | :-------------------------------------------------- |
| Subject CN         | `envoy-proxy-{short-name}`                          |
| SAN (URI)          | `spiffe://catalyst.example.com/envoy/app/{node-id}` |
| SAN (DNS)          | `envoy-proxy-{short-name}`                          |
| Key algorithm      | ECDSA P-384                                         |
| Validity           | 1 hour (default; configurable up to 24h)            |
| Basic Constraints  | `CA:FALSE`                                          |
| Key Usage          | `digitalSignature`                                  |
| Extended Key Usage | `serverAuth, clientAuth`                            |
| Issuer             | Transport CA                                        |

**Notes:** Application proxy handles ingress listeners (server) and
egress connections to remote Envoy proxies (client). Used for
L7 application data plane traffic.

#### 3.9 Envoy Transport Proxy End-Entity Certificate

| Field              | Value                                                     |
| :----------------- | :-------------------------------------------------------- |
| Subject CN         | `envoy-transport-{short-name}`                            |
| SAN (URI)          | `spiffe://catalyst.example.com/envoy/transport/{node-id}` |
| SAN (DNS)          | `envoy-proxy-{short-name}`                                |
| Key algorithm      | ECDSA P-384                                               |
| Validity           | 1 hour (default; configurable up to 24h)                  |
| Basic Constraints  | `CA:FALSE`                                                |
| Key Usage          | `digitalSignature`                                        |
| Extended Key Usage | `serverAuth, clientAuth`                                  |
| Issuer             | Transport CA                                              |

**Notes:** Transport proxy handles raw TCP/QUIC tunneling between
Envoy proxies on the envoy-mesh network. Separate from the app proxy
identity so that transport-level compromise does not grant L7 access.

#### 3.10 Peer Connection Certificate (Node-to-Node)

Node-to-node peering uses the **orchestrator certificate** (section 3.4).
When Node A peers with Node B:

1. Both nodes present their orchestrator certificates during mTLS handshake.
2. The `cnf` claim in the peer token (ADR 0007) binds the JWT to the
   SHA-256 thumbprint of the orchestrator certificate.
3. Validation requires: (a) valid cert chain to Root CA, (b) SPIFFE URI
   matches expected `spiffe://catalyst.example.com/orchestrator/{peer-node-id}`,
   (c) JWT `cnf.x5t#S256` matches the certificate thumbprint.

No additional certificate profile is needed for peering -- the
orchestrator identity serves dual purpose.

### 4. Key Usage and Extended Key Usage Summary

```
+-------------------------+------------------+-----------------------+
| Certificate             | Key Usage        | Extended Key Usage    |
+-------------------------+------------------+-----------------------+
| Root CA                 | keyCertSign      | (none)                |
|                         | cRLSign          |                       |
+-------------------------+------------------+-----------------------+
| Services CA             | keyCertSign      | (none)                |
|                         | cRLSign          |                       |
+-------------------------+------------------+-----------------------+
| Transport CA            | keyCertSign      | (none)                |
|                         | cRLSign          |                       |
+-------------------------+------------------+-----------------------+
| Orchestrator            | digitalSignature | serverAuth            |
|                         |                  | clientAuth            |
+-------------------------+------------------+-----------------------+
| Auth Service            | digitalSignature | serverAuth            |
|                         |                  | clientAuth            |
+-------------------------+------------------+-----------------------+
| Node Service            | digitalSignature | serverAuth            |
|                         |                  | clientAuth            |
+-------------------------+------------------+-----------------------+
| Gateway                 | digitalSignature | serverAuth            |
+-------------------------+------------------+-----------------------+
| Envoy App Proxy         | digitalSignature | serverAuth            |
|                         |                  | clientAuth            |
+-------------------------+------------------+-----------------------+
| Envoy Transport Proxy   | digitalSignature | serverAuth            |
|                         |                  | clientAuth            |
+-------------------------+------------------+-----------------------+
```

### 5. Certificate Lifetimes

| Certificate       | Default TTL | Max TTL  | Renewal Trigger        |
| :---------------- | :---------- | :------- | :--------------------- |
| Root CA           | 10 years    | 10 years | Manual ceremony        |
| Services CA       | 2 years     | 2 years  | 6 months before expiry |
| Transport CA      | 2 years     | 2 years  | 6 months before expiry |
| End-entity (SVID) | 1 hour      | 24 hours | At 50% lifetime        |

**Short-lived SVID rationale:**

The default 1-hour SVID lifetime aligns with SPIRE conventions and
eliminates the need for any revocation infrastructure for end-entity
certificates. If a service is compromised, the certificate becomes
invalid within 60 minutes -- fast enough that CRL/OCSP is unnecessary.

The 50% lifetime renewal trigger (at 30 minutes for 1-hour SVIDs)
provides a full half-TTL window for renewal to succeed.

**Configurable TTL:** Operators can extend the SVID TTL up to 24 hours
via `CATALYST_PKI_SVID_TTL` for environments with intermittent CA
connectivity. The 24-hour maximum is a hard cap enforced by the CA.
Longer lifetimes reintroduce the need for revocation infrastructure
and are not supported.

| Environment              | Recommended SVID TTL | Renewal Window |
| :----------------------- | :------------------- | :------------- |
| Cloud / always-connected | 1 hour (default)     | 30 minutes     |
| Edge / intermittent      | 4-8 hours            | 2-4 hours      |
| Air-gapped / testing     | 24 hours (max)       | 12 hours       |

### 6. Separation from JWT/Token Signing Keys

The PKI CA hierarchy and the JWT signing infrastructure are **completely
independent**. They must never share key material.

```
+===========================================================+
|                    INDEPENDENT TRUST DOMAINS               |
|                                                            |
|   +-------------------------+  +------------------------+  |
|   |     X.509 PKI Domain    |  |    JWT Signing Domain  |  |
|   |-------------------------|  |------------------------|  |
|   | Root CA (P-384)         |  | ES384 signing key      |  |
|   |   +-- Services CA       |  | (PersistentLocal-      |  |
|   |   +-- Transport CA      |  |  KeyManager)           |  |
|   |     +-- end-entity      |  |                        |  |
|   |                         |  | Stored in: SQLite      |  |
|   | Purpose: TLS identity,  |  | (BunSqliteKeyStore)    |  |
|   | mTLS authentication,    |  |                        |  |
|   | cert chain validation   |  | Purpose: token signing,|  |
|   |                         |  | JWKS publication,      |  |
|   | Storage: CA private     |  | token verification     |  |
|   | keys in HSM or          |  |                        |  |
|   | encrypted keystore;     |  | Rotation: via          |  |
|   | end-entity keys in      |  | JWTTokenFactory.rotate |  |
|   | memory (short-lived)    |  | with 24h grace period  |  |
|   +-------------------------+  +------------------------+  |
|                                                            |
|   BRIDGE: Certificate fingerprint in JWT 'cnf' claim      |
|   (ADR 0007). The JWT references the cert but uses its     |
|   own independent key to sign.                             |
+===========================================================+
```

**Where code reuse IS possible:**

| Concern                | Shared? | Notes                                                                                                                                                                                 |
| :--------------------- | :------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Key storage interface  | Yes     | `IKeyStore` pattern (save/load) works for both JWKS and PEM/DER cert stores. The abstraction layer is the same; the serialization format differs.                                     |
| Rotation mechanics     | Partial | Both need grace periods, old-key retention, and persistence. The `RotateOptions` / `RotationResult` pattern from the JWT key manager can be adapted for CA intermediate rotation.     |
| Policy enforcement     | Yes     | Cedar policies can authorize both token operations and certificate operations through the same `PermissionsHandlers` interface.                                                       |
| Telemetry              | Yes     | Both domains emit rotation, expiry, and validation metrics through `@catalyst/telemetry`.                                                                                             |
| SQLite storage backend | Partial | JWT keys use `BunSqliteKeyStore`. Certificate metadata (serial numbers, validity, thumbprints) can use a parallel SQLite store with the same migration patterns (ADR 0004, ADR 0009). |

**Where they MUST diverge:**

| Concern             | Why separate                                                                                                                                                            |
| :------------------ | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Key material        | CA keys sign certificates (X.509 tbsCertificate). JWT keys sign tokens (JOSE compact serialization). Different key purposes, different compromise blast radius.         |
| Algorithms (future) | JWT signing may migrate to EdDSA (Ed25519) for speed. X.509 must stay on P-384 or move to ML-DSA for post-quantum. Independent algorithm migration paths.               |
| Trust chain         | X.509 has a hierarchical chain (Root -> Intermediate -> Leaf). JWT uses flat JWKS with `kid` selection. No chain walking.                                               |
| Revocation model    | X.509 end-entity: short-lived (no revocation needed). X.509 CA: CRL. JWT: token-level revocation via `TokenStore.revokeToken()` + VRL. Completely different mechanisms. |
| Key lifetime        | CA keys live years. JWT signing keys rotate every hours/days. Mixing them would create impossible lifecycle conflicts.                                                  |

### 7. Revocation Strategy

#### 7.1 End-Entity SVIDs: Short-Lived (Passive Revocation)

End-entity SVIDs have a default 1-hour lifetime (max 24 hours). This
is the primary revocation mechanism -- compromised certificates expire
naturally. No CRL or OCSP infrastructure is needed for end-entity certs.

For immediate response, the CA stops issuing new certificates to the
compromised identity. The current certificate becomes invalid within
one TTL period (1 hour default).

**Emergency SVID revocation:** If the TTL window is unacceptable, the
trust bundle can be updated to exclude the specific certificate's serial
number via a lightweight deny-list distributed through the xDS control
plane. This is a safety net, not the primary mechanism.

#### 7.2 Intermediate CA Compromise: Trust Bundle Update

If an intermediate CA is compromised (critical security event), the
primary response is a **trust bundle update** that excludes the
compromised CA:

1. Remove the compromised intermediate CA certificate from the trust
   bundle distributed to all services.
2. Push the updated trust bundle to all nodes via config update,
   volume remount, or xDS push.
3. All services reload their trust stores, immediately rejecting
   any certificate signed by the compromised CA.

This is faster and simpler than CRL distribution because it does not
require the Root CA to sign anything -- it is purely a trust bundle
configuration change.

As a secondary measure, the Root CA can also sign a CRL formally
revoking the intermediate. This is for defense-in-depth and for
any systems that validate via chain walking rather than trust bundle
membership.

Intermediate CA keys should be stored in HSMs or encrypted keystores
to minimize the likelihood of this scenario.

#### 7.3 JWT Tokens: Token-Level Revocation (Existing)

JWT token revocation continues to use the existing `TokenStore`
infrastructure (`revokeToken`, `revokeBySan`, `getRevocationList`).
This is completely independent of X.509 certificate revocation.

#### 7.4 Revocation Architecture Summary

```
+-------------------------------------------------------------------+
| Layer             | Mechanism          | Frequency     | Scope     |
|-------------------|--------------------|---------------|-----------|
| Root CA           | Manual ceremony    | ~never        | All certs |
| Intermediate CA   | Trust bundle update| ~never        | All certs |
|                   | + optional CRL     |               | under CA  |
| End-entity SVID   | Short-lived (1h)   | Not needed    | One svc   |
| Emergency SVID    | Trust bundle deny  | Rare          | One svc   |
| JWT tokens        | TokenStore VRL     | Operational   | One token |
+-------------------------------------------------------------------+
```

### 8. Trust Relationships by Network Segment

The three-node compose topology (three-node.compose.yaml) defines the
network segments that map to trust boundaries:

```
+-------------------------------------------------------------------+
|                        NETWORK TOPOLOGY                           |
|                                                                   |
|  stack-{a,b,c}-control                                            |
|  +-------------------------------------------------------------+ |
|  | auth <--mTLS(Services CA)--> orchestrator                    | |
|  | orchestrator <--mTLS(Services CA)--> envoy-svc               | |
|  | envoy-svc <--plaintext(localhost)--> envoy-proxy             | |
|  +-------------------------------------------------------------+ |
|                                                                   |
|  stack-{a,b,c}-data                                               |
|  +-------------------------------------------------------------+ |
|  | envoy-proxy <--plaintext--> downstream (books, curl)         | |
|  | (mTLS between envoy-proxy and downstream is OPTIONAL,        | |
|  |  depends on data channel protocol)                           | |
|  +-------------------------------------------------------------+ |
|                                                                   |
|  orchestrator-mesh (cross-stack)                                  |
|  +-------------------------------------------------------------+ |
|  | orch-a <--mTLS(Services CA) + cnf-bound JWT--> orch-b        | |
|  | orch-b <--mTLS(Services CA) + cnf-bound JWT--> orch-c        | |
|  +-------------------------------------------------------------+ |
|                                                                   |
|  envoy-mesh (cross-stack)                                         |
|  +-------------------------------------------------------------+ |
|  | envoy-proxy-a <--mTLS(Transport CA)--> envoy-proxy-b         | |
|  | envoy-proxy-b <--mTLS(Transport CA)--> envoy-proxy-c         | |
|  +-------------------------------------------------------------+ |
+-------------------------------------------------------------------+
```

**Trust anchor distribution:**

| Network Segment   | Trust Anchor (CA Bundle)                |
| :---------------- | :-------------------------------------- |
| stack-X-control   | Services CA cert + Root CA cert         |
| orchestrator-mesh | Services CA cert + Root CA cert         |
| envoy-mesh        | Transport CA cert + Root CA cert        |
| stack-X-data      | Application-dependent (not PKI-managed) |
| xDS (envoy-svc)   | Localhost only (no TLS required)        |

### 9. Certificate Delivery Mechanism

For short-lived certificates, a push-based renewal mechanism is required:

1. **Bootstrap:** On first start, a service generates a key pair and
   submits a CSR to the CA (the auth service or a dedicated CA endpoint).
   The CSR is authenticated using the bootstrap token
   (`CATALYST_BOOTSTRAP_TOKEN`).

2. **Renewal:** At 50% certificate lifetime, the service generates a
   new key pair, signs a CSR with the current certificate's private key
   (proving possession), and submits it to the CA.

3. **Delivery format:** Certificates are delivered as PEM bundles
   (leaf + intermediate chain). Private keys never leave the service
   that generated them.

4. **Envoy integration:** Envoy proxies receive certificates via SDS
   (Secret Discovery Service) from the envoy-service control plane,
   which acts as the SDS server. The envoy-service obtains certificates
   from the Transport CA on behalf of its Envoy proxy.

```
+------------------+     CSR      +------------------+
| Orchestrator     | -----------> |   Services CA    |
| (generates key,  |              |   (auth service  |
|  sends CSR)      | <----------- |    or dedicated  |
|                  |  PEM bundle  |    CA endpoint)  |
+------------------+              +------------------+

+------------------+     CSR      +------------------+
| Envoy Service    | -----------> |  Transport CA    |
| (on behalf of    |              |  (dedicated CA   |
|  envoy-proxy)    | <----------- |   endpoint)      |
|                  |  PEM bundle  |                  |
+------ SDS ------+              +------------------+
        |
        v
+------------------+
| Envoy Proxy      |
| (receives cert   |
|  via SDS)        |
+------------------+
```

### 10. Implementation Notes

#### 10.1 X.509 Library Selection

Bun's native `crypto` module has limited X.509 generation support.
Use `@peculiar/x509` for certificate and CSR operations:

- Built on W3C `SubtleCrypto` (Bun-compatible, no native addons)
- Full X.509 v3 extension support (SAN, key usage, basic constraints,
  name constraints, SPIFFE URI SANs)
- CSR generation and signing
- Certificate chain validation

The existing `jose` v6 library continues to handle JWT operations
exclusively. These two libraries operate in separate domains and
must not share key material.

#### 10.2 Post-Quantum Algorithm Roadmap

PQ algorithm support in the JS/Bun ecosystem is immature (Phase 2).
Phase 1 uses ECDSA P-384 exclusively. The target PQ algorithms,
based on NIST FIPS 204 standardization and library availability:

**Target PQ algorithms (Phase 2):**

| Certificate       | Phase 1 (now) | Phase 2 (PQ)             | Rationale                            |
| :---------------- | :------------ | :----------------------- | :----------------------------------- |
| Root CA           | ECDSA P-384   | ML-DSA-87                | Highest security for long-lived root |
| Services CA       | ECDSA P-384   | ML-DSA-65                | Balanced perf/security for online CA |
| Transport CA      | ECDSA P-384   | ECDSA P-384              | Envoy lacks PQ support (BoringSSL)   |
| Service SVIDs     | ECDSA P-384   | ML-DSA-65                | Direct service-to-service mTLS       |
| Envoy SVIDs       | ECDSA P-384   | ECDSA P-384              | Envoy classical TLS only             |
| mTLS key exchange | ECDHE P-384   | Hybrid X25519+ML-KEM-768 | PQ key encapsulation                 |

**Why Envoy stays classical:** Envoy uses BoringSSL which has
experimental PQ support, but Envoy itself has not integrated PQ
cipher suites. The Transport CA and Envoy SVIDs remain classical
until Envoy adds PQ TLS support (monitor `envoy-openssl` project).
The two-intermediate CA structure enables this split -- Services CA
migrates to PQ while Transport CA stays classical.

**Conservative fallback:** SLH-DSA (SPHINCS+, hash-based) provides
a mathematically distinct PQ alternative if lattice-based ML-DSA is
broken. The `ICaKeyStore` abstraction supports algorithm switching
without CA hierarchy changes.

**Library strategy for Phase 2:**

1. OpenSSL 3.5+ CLI for CA signing operations (most mature, FIPS-capable)
2. `@openforge-sh/liboqs-node` (WASM) for in-process PQ signature
   verification in the Bun runtime
3. Monitor Bun native OpenSSL 3.5 convergence for integrated support

**Cloud KMS for PQ CA keys:** AWS KMS supports ML-DSA-44/65/87
(GA, hardware HSM-backed). GCP Cloud KMS ML-DSA is in Preview.
The `ICaKeyStore` interface is designed to be KMS-agnostic,
supporting both local and cloud-backed key storage.

**No PQ in Phase 1:** All Phase 1 certificates use ECDSA P-384
via `@peculiar/x509` (SubtleCrypto). PQ migration is a separate
ADR with its own implementation timeline.

#### 10.3 CA Key Storage Abstraction

The CA private key storage must be abstracted behind an interface
compatible with future HSM/KMS backing:

```typescript
interface ICaKeyStore {
  /** Sign a TBS (to-be-signed) certificate or CRL */
  sign(tbs: Uint8Array, algorithm: string): Promise<Uint8Array>
  /** Get the CA's public key for chain building */
  getPublicKey(): Promise<CryptoKey>
  /** Get the CA certificate (PEM) */
  getCaCertificate(): Promise<string>
}
```

Phase 1 implements this with in-process keys (encrypted at rest in
SQLite). Phase 2 adds cloud KMS and HSM backends behind the same
interface:

- **AWS KMS:** ML-DSA-44/65/87 support is GA (hardware HSM-backed).
  The `sign()` method maps to `kms:Sign` with `ECDSA_SHA_384` (Phase 1)
  or `ML_DSA_65` (Phase 2).
- **GCP Cloud KMS:** ML-DSA support is in Preview. Same interface
  mapping via `asymmetricSign`.
- **PKCS#11 HSM:** For on-premises HSM appliances (Thales, nCipher).

The interface is intentionally KMS-agnostic. Implementation backends
are selected via configuration, not code changes.

#### 10.4 Replacing CATALYST_PEERING_SECRET

The `CATALYST_PEERING_SECRET` environment variable currently used in
docker-compose configurations is the trust mechanism that PKI replaces.
Migration path:

1. **Phase 1:** Add mTLS support alongside the existing secret.
   Accept both mechanisms during transition.
2. **Phase 2:** Deprecate `CATALYST_PEERING_SECRET`. Log warnings
   when it is configured.
3. **Phase 3:** Remove secret-based authentication entirely. All
   peering uses mTLS + certificate-bound JWTs (ADR 0007).

#### 10.5 Federated Trust (Multi-Organization)

For cross-organization federation, each organization runs its own
Root CA with trust domain (e.g., `spiffe://acme.catalyst.io`).
Federation is established by:

1. Exchanging Root CA certificates between organizations.
2. Configuring trust bundles that include the foreign Root CA.
3. Using SPIFFE trust domain validation to restrict which foreign
   identities are accepted (e.g., only accept
   `spiffe://partner.catalyst.io/orchestrator/*`).

This requires no changes to the certificate profiles -- only trust
bundle configuration at the node level.

## Consequences

### Positive

- **Defense in depth:** Compromise of a Transport CA leaf cert does not
  grant access to control-plane APIs (separate intermediate CAs).
- **No revocation infrastructure for end-entity:** Short-lived certs
  eliminate OCSP/CRL complexity for the common case.
- **SPIFFE compatibility:** URI SANs enable future SPIRE integration
  and Envoy SDS without protocol changes.
- **Clean separation from JWT:** Independent key lifecycle prevents
  cascading failures between token signing and TLS identity.
- **Auditable identity:** Every service has a unique, verifiable SPIFFE
  identity that can be used in Cedar policy decisions.

### Negative

- **CA availability is critical:** If the CA is unreachable for >30 minutes
  (half the default 1-hour SVID TTL), services cannot renew certificates.
  Mitigation: CA high availability; configurable TTL up to 24 hours for
  environments with intermittent connectivity.
- **Operational complexity:** Two intermediate CAs require independent
  rotation ceremonies every ~18 months.
- **Bootstrap trust:** Initial CSR authentication relies on bootstrap
  tokens, which are a weaker form of trust. Mitigation: bootstrap tokens
  are short-lived (1 hour, per the config comment in `packages/config`).
- **Key generation overhead:** Each service generates a new P-384 key pair
  every 30 minutes (at 50% of the default 1-hour TTL). This is negligible
  on modern hardware (~1ms per P-384 keygen). Note: ML-DSA keygen in
  Phase 2 is also sub-millisecond.
- **Envoy PQ gap:** The Transport CA and Envoy SVIDs cannot migrate to PQ
  algorithms until Envoy integrates PQ cipher suites from BoringSSL. This
  creates a split where service-to-service mTLS is PQ-protected but
  Envoy mesh traffic remains classical.
