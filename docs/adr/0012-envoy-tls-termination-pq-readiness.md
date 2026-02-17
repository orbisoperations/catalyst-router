# ADR 0012: Envoy TLS Termination and Post-Quantum Readiness

**Status:** Proposed
**Date:** 2026-02-17
**Decision Owner(s):** Platform Team

## Context

Catalyst services communicate over multiple network segments: control-plane
(orchestrator mesh, auth RPC), data-plane (Envoy-proxied application traffic),
and cross-node (Envoy mesh). Today, all internal traffic is plaintext HTTP.
ADR 0011 established the PKI hierarchy and certificate profiles, but TLS
termination has not been implemented.

Separately, NIST has finalized post-quantum (PQ) cryptography standards
(FIPS 203: ML-KEM, FIPS 204: ML-DSA) and the CNSA 2.0 timeline requires
PQ readiness by 2027 for new equipment. We need a path to PQ TLS that
works with our current runtime constraints.

### Current State

- All `Bun.serve()` calls are plaintext HTTP
- Envoy proxies route application traffic but without TLS
- PKI infrastructure exists (ADR 0011) but certificates are not used for transport
- Bun 1.3.6 bundles BoringSSL, which does NOT support:
  - ML-DSA certificate signing in TLS
  - Configurable PQ key exchange groups (`ecdhCurve`/`groups` not exposed)
- Envoy's BoringSSL DOES support `X25519MLKEM768` via the `ecdh_curves` config

### Requirements

| Requirement                                    | Priority | Notes                           |
| ---------------------------------------------- | -------- | ------------------------------- |
| mTLS for all inter-service communication       | Must     | Zero-trust posture              |
| PQ key exchange on external-facing connections | Must     | CNSA 2.0 compliance path        |
| Certificate-bound token validation (ADR 0007)  | Must     | Fingerprint must reach backend  |
| No application-level TLS code in Bun services  | Should   | Simplify service implementation |
| SPIFFE identity propagation to backends        | Must     | For authorization decisions     |
| Forward compatibility with PQ cert signing     | Should   | When BoringSSL adds ML-DSA      |

## Decision

**Chosen Option: Envoy-terminated TLS with XFCC header propagation**

All TLS termination happens at the Envoy proxy layer. Backend Bun services
receive identity information via the `X-Forwarded-Client-Cert` (XFCC)
HTTP header. Bun services never handle TLS directly.

### Rationale

1. **Envoy already supports PQ key exchange** -- `X25519MLKEM768` works
   in Envoy 1.33.2+ via the `ecdh_curves` TLS parameter. No custom builds
   or forks required.
2. **Eliminates Bun PQ gap** -- Bun's BoringSSL cannot do PQ key exchange
   or PQ cert signing. By terminating TLS at Envoy, this limitation is
   irrelevant.
3. **Simpler service code** -- Services read an HTTP header instead of
   managing TLS contexts, certificate loading, and handshakes.
4. **Single TLS termination point** -- Easier to audit, rotate certs,
   and enforce policy in one place per node.
5. **XFCC provides full certificate context** -- Envoy's XFCC header
   includes SHA-256 fingerprint (`Hash`), SPIFFE URI (`URI`), subject
   (`Subject`), and DNS SANs (`DNS`) -- everything needed for
   certificate-bound token validation (ADR 0007 `cnf.x5t#S256`).

### Trade-offs Accepted

- **Envoy becomes a hard dependency for secure communication.** Services
  behind Envoy cannot independently verify peer certificates at the TLS
  layer -- they trust Envoy's XFCC header. This is acceptable because
  Envoy is already a hard dependency for data-plane routing.
- **XFCC header spoofing risk.** If an attacker bypasses Envoy and
  connects directly to a backend, they could forge XFCC headers.
  Mitigation: backends bind to localhost only; Envoy uses
  `SANITIZE_SET` mode to strip and rebuild XFCC on every request.
- **Localhost communication is plaintext.** Traffic between Envoy and
  backend services on the same host is unencrypted. This is standard
  practice (sidecar model) and acceptable for containerized deployments
  where the network namespace is shared.

## Architecture

```
External / Cross-Node Traffic
         |
         v
+--[Envoy Proxy]------------------------------------------+
|  TLS 1.3 + X25519MLKEM768 (PQ hybrid key exchange)      |
|  mTLS: validates client cert against CA trust bundle     |
|  XFCC: extracts Hash, URI, Subject, DNS from client cert |
|  forward_client_cert_details: SANITIZE_SET               |
+----------------------------------------------------------+
         |
         | plaintext HTTP + XFCC header
         v
+--[Bun Service]-------------------------------------------+
|  Reads X-Forwarded-Client-Cert header                    |
|  Extracts:                                               |
|    - Hash (SHA-256 fingerprint) -> matches JWT cnf claim |
|    - URI (SPIFFE ID) -> authorization decisions          |
|  No TLS code, no cert loading, no handshake management   |
+----------------------------------------------------------+
```

### XFCC Header Format

```
Hash=<sha256>;URI=spiffe://trust.domain/service/instance;Subject="CN=instance";DNS=instance
```

### Token Binding Verification

```
1. JWT contains: cnf.x5t#S256 = "<cert-fingerprint>"
2. XFCC contains: Hash=<cert-fingerprint>
3. Backend compares: jwt.cnf.x5t#S256 === xfcc.Hash
4. Match = token is bound to the presenting certificate
```

### Network Segments

| Segment                     | TLS Termination        | PQ Key Exchange | Identity Propagation  |
| --------------------------- | ---------------------- | --------------- | --------------------- |
| Envoy mesh (cross-node)     | Envoy ingress listener | X25519MLKEM768  | mTLS cert validation  |
| Stack control (intra-node)  | Envoy ingress listener | X25519MLKEM768  | XFCC header           |
| Orchestrator mesh (peering) | Envoy ingress listener | X25519MLKEM768  | XFCC + cert-bound JWT |
| xDS management              | Localhost only         | N/A (no TLS)    | Trusted by locality   |
| Stack data (app traffic)    | Envoy ingress listener | X25519MLKEM768  | XFCC header           |

### Envoy TLS Configuration (xDS)

Added to ingress listeners via the xDS resource builder:

```yaml
# Downstream TLS context (on ingress listeners)
transport_socket:
  name: envoy.transport_sockets.tls
  typed_config:
    '@type': type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.DownstreamTlsContext
    common_tls_context:
      tls_params:
        tls_minimum_protocol_version: TLSv1_3
        ecdh_curves:
          - X25519MLKEM768
          - X25519
          - P-256
      tls_certificates:
        - certificate_chain: { inline_string: '<node-cert-pem>' }
          private_key: { inline_string: '<node-key-pem>' }
      validation_context:
        trusted_ca: { inline_string: '<ca-bundle-pem>' }
    require_client_certificate: true

# HTTP connection manager
forward_client_cert_details: SANITIZE_SET
set_current_client_cert_details:
  uri: true
  subject: true
  dns: true
  cert: false # full PEM not needed, fingerprint suffices
```

## Consequences

### Positive

- **PQ-ready today** -- X25519MLKEM768 hybrid key exchange via Envoy
  without waiting for Bun runtime support
- **Simpler services** -- No TLS code in any Bun service; just header parsing
- **Single audit point** -- All TLS config lives in xDS resources,
  managed by the control plane
- **Certificate-bound tokens work** -- XFCC Hash field provides the
  fingerprint needed for ADR 0007 `cnf.x5t#S256` validation
- **Forward compatible** -- When Envoy's BoringSSL adds ML-DSA cert
  support, we update certs without changing service code

### Negative

- **All services must go through Envoy** -- Direct service-to-service
  calls bypass TLS. This requires architectural enforcement (bind to
  localhost, network policies).
- **Envoy availability is critical** -- If Envoy is down, no service
  communication works. Mitigation: Envoy is already critical for
  data-plane routing.
- **XFCC parsing overhead** -- Each request requires header parsing.
  Negligible compared to TLS handshake cost.

### Neutral

- **ADR 0011 Section 10.2 update** -- The PQ algorithm roadmap table
  changes: Envoy handles PQ key exchange (not "Envoy classical TLS only").
  Transport CA certs stay ECDSA P-384 (BoringSSL still can't sign ML-DSA),
  but key exchange is PQ-hybrid.

## Implementation

### Phase 1: Bootstrapped Control-Plane Channels

Force orchestrator, auth, and envoy-service communication through Envoy
with mTLS + XFCC. This covers the control-plane network segment.

1. Add TLS context to xDS ingress listeners (cert/key via SDS or inline)
2. Add XFCC configuration to HTTP connection manager
3. Create XFCC parsing middleware for Hono
4. Wire certificate-bound token validation through XFCC
5. Add `ecdh_curves: [X25519MLKEM768, X25519, P-256]` to TLS params

### Phase 2: Data-Plane Channels

Extend TLS to all data-channel listeners (application traffic).

### Phase 3: Cross-Node Envoy Mesh

Add mTLS between Envoy proxies on the envoy-mesh network using
Transport CA certificates.

## Risks and Mitigations

| Risk                                | Likelihood | Impact | Mitigation                                                 |
| ----------------------------------- | ---------- | ------ | ---------------------------------------------------------- |
| XFCC header spoofing                | Low        | High   | Backends bind localhost; SANITIZE_SET strips incoming XFCC |
| Envoy PQ group not negotiated       | Low        | Medium | Fallback to X25519 (still secure, not PQ)                  |
| Certificate rotation during traffic | Medium     | Medium | Envoy hot-reloads certs via SDS; no connection drops       |
| Increased Envoy resource usage      | Low        | Low    | TLS 1.3 session resumption reduces handshake cost          |

## Related Decisions

- [ADR 0007](./0007-certificate-bound-access-tokens.md) - Certificate-bound tokens (cnf claim)
- [ADR 0011](./0011-pki-hierarchy-and-certificate-profiles.md) - PKI hierarchy and cert profiles

## References

- [Envoy XFCC documentation](https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_conn_man/headers)
- [Envoy ecdh_curves TLS parameter](https://www.envoyproxy.io/docs/envoy/latest/api-v3/extensions/transport_sockets/tls/v3/common.proto)
- [Envoy #33941 - X25519MLKEM768 confirmed working](https://github.com/envoyproxy/envoy/issues/33941)
- [Istio #55588 - X25519MLKEM768 support merged](https://github.com/istio/istio/issues/55588)
- [RFC 8705 - OAuth 2.0 Mutual-TLS Certificate-Bound Access Tokens](https://datatracker.ietf.org/doc/html/rfc8705)
- [NIST FIPS 203 - ML-KEM](https://csrc.nist.gov/pubs/fips/203/final)
- [CNSA 2.0 Algorithm Suite](https://media.defense.gov/2022/Sep/07/2003071834/-1/-1/0/CSA_CNSA_2.0_ALGORITHMS_.PDF)

---

## Appendix: Options Considered

<details>
<summary>Click to expand full options analysis</summary>

### Option 1: Bun-native TLS termination

Each Bun service handles its own TLS via `Bun.serve({ tls: ... })`.

**Approach:**

- Add TLS config to `CatalystHonoServerOptions`
- Each service loads its own cert/key
- Build `secureOptions` bitmask for TLS 1.3 enforcement

**Pros:**

- No Envoy dependency for TLS
- Each service independently verifiable

**Cons:**

- Bun's BoringSSL cannot do PQ key exchange (no `ecdhCurve` option)
- Bun's BoringSSL cannot load ML-DSA certificates
- Every service needs TLS code (cert loading, renewal, error handling)
- Multiple TLS termination points to audit
- Tested and confirmed: PQ is a dead end in Bun today

### Option 2: Envoy TLS termination with XFCC (chosen)

Envoy handles all TLS. Services receive identity via XFCC header.

**Approach:**

- Add TLS context to xDS listener resources
- Configure XFCC header forwarding
- Services parse XFCC for identity and token binding

**Pros:**

- PQ key exchange works today (X25519MLKEM768)
- No TLS code in services
- Single audit point
- XFCC provides cert fingerprint for token binding

**Cons:**

- Envoy hard dependency
- XFCC spoofing risk (mitigated by SANITIZE_SET + localhost binding)
- Plaintext between Envoy and backend (standard sidecar model)

### Option 3: Hybrid (Envoy for PQ, Bun for classical mTLS)

Envoy handles external PQ TLS; Bun handles internal classical mTLS.

**Approach:**

- External: Envoy with X25519MLKEM768
- Internal: Bun.serve() with ECDSA P-384 mTLS

**Pros:**

- Defense in depth (TLS at both layers)
- Internal traffic is encrypted even if network is compromised

**Cons:**

- Double TLS overhead
- Complexity of managing two TLS layers
- Still no PQ on internal segments
- Significantly more code to maintain

</details>
