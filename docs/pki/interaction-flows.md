# PKI Interaction Flows

This document describes every PKI interaction in the Catalyst system.
Each flow includes step-by-step sequences, data exchanged, validation
logic, failure modes, and how errors surface to operators.

**Reference documents:**

- ADR 0011: PKI Hierarchy, Certificate Profiles, and SPIFFE Identity Scheme
- ADR 0007: Certificate-Bound Access Tokens for BGP Sessions
- RFC 8705: OAuth 2.0 Mutual-TLS Client Authentication and Certificate-Bound Access Tokens
- RFC 7800: Proof-of-Possession Key Semantics for JSON Web Tokens (JWTs)

**RFC 8705 terminology mapping:**

| RFC 8705 Term                        | Catalyst Equivalent                                  |
| :----------------------------------- | :--------------------------------------------------- |
| Authorization Server                 | Auth Service (`AuthRpcServer`)                       |
| Protected Resource                   | Orchestrator (`CatalystNodeBus.publicApi()`)         |
| Client                               | Peer orchestrator / CLI / service                    |
| Mutual-TLS client authentication     | mTLS handshake on orchestrator-mesh                  |
| Certificate-bound access token       | JWT with `cnf.x5t#S256` claim (peer token)           |
| Confirmation method (`cnf`)          | `cnf: { "x5t#S256": "<thumbprint>" }` in JWT payload |
| X.509 Certificate SHA-256 Thumbprint | SHA-256 hash of DER-encoded client certificate       |

---

## Flow 1: First-Time PKI Bootstrap

**Trigger:** Auth service starts for the first time with no existing CA state.

**Components:** Auth Service, SQLite (certificate store), filesystem/HSM.

```
Auth Service                     Certificate Store (SQLite)
    |                                     |
    |  1. onInitialize()                  |
    |  2. Check for existing Root CA ---->|
    |  3. No CA found <------------------|
    |  4. Generate Root CA key pair       |
    |     (ECDSA P-384, extractable)      |
    |  5. Self-sign Root CA cert          |
    |     CN: "Catalyst Root CA"          |
    |     pathlen:1, 10yr validity        |
    |  6. Store Root CA ----------------->|
    |  7. Generate Services CA key pair   |
    |  8. Sign Services CA cert           |
    |     (signed by Root CA)             |
    |     CN: "Catalyst Services CA"      |
    |     pathlen:0, 2yr validity         |
    |  9. Store Services CA ------------->|
    | 10. Generate Transport CA key pair  |
    | 11. Sign Transport CA cert          |
    |     (signed by Root CA)             |
    |     CN: "Catalyst Transport CA"     |
    |     pathlen:0, 2yr validity         |
    | 12. Store Transport CA ------------>|
    | 13. Log: "PKI initialized"          |
    | 14. Expose CA bundle endpoint       |
    |     GET /pki/ca/bundle              |
    |                                     |
```

**Step details:**

1. `AuthService.onInitialize()` calls `PKIManager.initialize()`.
2. PKIManager queries `ICertificateStore.loadCaCertificate('root')`.
3. Store returns `null` -- no existing Root CA.
4. Generate P-384 key pair via `crypto.subtle.generateKey()` (ECDSA, P-384, extractable: true).
5. Create self-signed X.509 certificate using `@peculiar/x509`:
   - Subject: `CN=Catalyst Root CA`
   - Basic Constraints: `CA:TRUE, pathlen:1`
   - Key Usage: `keyCertSign, cRLSign`
   - Validity: `notBefore=now, notAfter=now+10years`
   - No SAN (root CAs don't have SPIFFE identities)
6. Store Root CA certificate + encrypted private key in SQLite via `ICertificateStore.saveCaCertificate()`.
7. Generate second P-384 key pair for Services CA.
8. Create CSR internally, sign with Root CA private key:
   - Subject: `CN=Catalyst Services CA`
   - Basic Constraints: `CA:TRUE, pathlen:0`
   - Key Usage: `keyCertSign, cRLSign`
   - Name Constraints: Permitted URIs for `spiffe://<trust-domain>/orchestrator/`, `/auth/`, `/node/`, `/gateway/`
   - Validity: 2 years
9. Store Services CA certificate + encrypted private key.
10. Generate third P-384 key pair for Transport CA.
11. Same signing flow as step 8:
    - Subject: `CN=Catalyst Transport CA`
    - Name Constraints: Permitted URIs for `spiffe://<trust-domain>/envoy/`
    - Validity: 2 years
12. Store Transport CA certificate + encrypted private key.
13. Log to telemetry: `PKI CA hierarchy initialized (root + 2 intermediates)`.
14. Mount `/pki/ca/bundle` endpoint on the Hono handler.

**Validation at each step:**

- Step 5: Verify self-signature on Root CA cert before storing.
- Step 8: Verify Services CA cert chains to Root CA.
- Step 11: Verify Transport CA cert chains to Root CA.
- Step 6/9/12: Verify store round-trip (load after save, compare fingerprints).

**Failure modes:**

| Failure                    | Symptom                             | Operator Action                    |
| :------------------------- | :---------------------------------- | :--------------------------------- |
| Key generation fails       | `Error: SubtleCrypto not available` | Verify Bun version supports P-384  |
| SQLite write fails         | `Error: SQLITE_CANTOPEN`            | Check file permissions, disk space |
| Root CA already exists     | Skip to step 7 (not a failure)      | Normal restart behavior            |
| Intermediate signing fails | `Error: Root CA key not available`  | Check certificate store integrity  |

**Operator visibility:** All steps logged at INFO level. Root CA fingerprint logged for verification. System token printed to stdout (same as current behavior in `AuthService.onInitialize()`).

---

## Flow 2: Service Certificate Bootstrap

**Trigger:** A new service (e.g., orchestrator) starts and needs its first X.509-SVID.

**Components:** Service (e.g., Orchestrator), Auth Service (CA endpoint).

```
Orchestrator                     Auth Service (CA)
    |                                   |
    | 1. Generate P-384 key pair        |
    | 2. Build CSR:                     |
    |    CN: node-a.somebiz.local.io    |
    |    SAN URI: spiffe://catalyst.    |
    |      example.com/orchestrator/    |
    |      node-a.somebiz.local.io      |
    |    SAN DNS: node-a.somebiz...     |
    | 3. POST /pki/csr/sign ----------->|
    |    Headers:                        |
    |      Authorization: Bearer        |
    |        <bootstrap-token>          |
    |    Body: { csr: <PEM>,            |
    |      serviceType: "orchestrator", |
    |      nodeId: "node-a..." }        |
    |                                   |
    |                 4. Verify bootstrap token
    |                 5. Parse and validate CSR:
    |                    - Valid signature
    |                    - SPIFFE URI matches serviceType+nodeId
    |                    - Key algorithm is P-384
    |                 6. Sign CSR with Services CA
    |                    - Set validity: 1 hour (default)
    |                    - Set EKU: serverAuth, clientAuth
    |                    - Set Basic Constraints: CA:FALSE
    |                 7. Record cert in certificate store
    |                    (serial, SPIFFE ID, thumbprint, expiry)
    |                                   |
    | 8. Response <--------------------|
    |    { certificate: <PEM>,          |
    |      chain: [ServicesCACert,      |
    |              RootCACert],         |
    |      expiresAt: <ISO timestamp>,  |
    |      renewAfter: <ISO timestamp>} |
    |                                   |
    | 9. Validate received cert:        |
    |    - Chains to Root CA            |
    |    - SAN URI matches request      |
    |    - Not expired                  |
    |10. Store cert + private key       |
    |    in memory (short-lived)        |
    |11. Configure TLS server with cert |
    |12. Schedule renewal timer at      |
    |    renewAfter (50% lifetime)      |
    |                                   |
```

**Request payload (step 3):**

```json
{
  "csr": "-----BEGIN CERTIFICATE REQUEST-----\nMIIB...\n-----END CERTIFICATE REQUEST-----",
  "serviceType": "orchestrator",
  "nodeId": "node-a.somebiz.local.io"
}
```

**Response payload (step 8):**

```json
{
  "certificate": "-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----",
  "chain": [
    "-----BEGIN CERTIFICATE-----\n<Services CA cert>\n-----END CERTIFICATE-----",
    "-----BEGIN CERTIFICATE-----\n<Root CA cert>\n-----END CERTIFICATE-----"
  ],
  "expiresAt": "2026-02-13T14:30:00Z",
  "renewAfter": "2026-02-13T14:00:00Z"
}
```

**Validation at each step:**

- Step 3: Bootstrap token must be valid JWT, not expired, with ADMIN principal.
- Step 5: CSR signature proves possession of private key; SPIFFE URI must match the `serviceType/nodeId` pair; key algorithm must be P-384 (or ML-DSA-65 in Phase 2).
- Step 6: Services CA (not Transport CA) must sign service certs; validity must not exceed 24-hour maximum.
- Step 9: Client verifies the full chain: leaf -> Services CA -> Root CA.

**Failure modes:**

| Failure                   | HTTP Status | Error                               | Operator Action                        |
| :------------------------ | :---------- | :---------------------------------- | :------------------------------------- |
| Bootstrap token expired   | 401         | `Token expired`                     | Restart with fresh bootstrap token     |
| Bootstrap token invalid   | 401         | `Invalid token`                     | Check CATALYST_BOOTSTRAP_TOKEN env var |
| CSR SPIFFE URI mismatch   | 400         | `SPIFFE URI does not match request` | Verify serviceType and nodeId          |
| Unsupported key algorithm | 400         | `Key algorithm must be P-384`       | Regenerate key pair with correct algo  |
| Services CA expired       | 500         | `Signing CA certificate expired`    | Rotate intermediate CA (Flow 11)       |
| Services CA unavailable   | 503         | `CA not initialized`                | Wait for auth service to complete init |
| SPIFFE ID denied (Flow 9) | 403         | `Identity denied: <SPIFFE URI>`     | Check deny list, contact admin         |

---

## Flow 3: Certificate Renewal

**Trigger:** Renewal timer fires at 50% of certificate lifetime (30 minutes for 1-hour SVIDs).

**Components:** Service (any), Auth Service (CA endpoint).

```
Service                          Auth Service (CA)
    |                                   |
    | 1. Renewal timer fires            |
    |    (at 50% lifetime)              |
    | 2. Generate NEW P-384 key pair    |
    | 3. Build CSR (same SPIFFE ID)     |
    | 4. POST /pki/csr/sign ----------->|
    |    Headers:                        |
    |      Authorization: Bearer        |
    |        <current-cert-signed-JWT>  |
    |    Body: { csr: <PEM>,            |
    |      serviceType: "orchestrator", |
    |      nodeId: "node-a..." }        |
    |                                   |
    |                 5. Verify caller's current cert:
    |                    - mTLS: extract client cert
    |                    - Verify chain to Root CA
    |                    - Verify cert not expired
    |                    - Verify SPIFFE ID matches CSR
    |                 6. Verify identity not denied
    |                 7. Sign new CSR with Services CA
    |                    (same validation as Flow 2)
    |                 8. Record new cert, mark old as superseded
    |                                   |
    | 9. Response <--------------------|
    |    (same format as Flow 2)        |
    |                                   |
    |10. Hot-swap: load new cert+key    |
    |    into TLS context               |
    |11. Old cert remains valid until   |
    |    natural expiry (no revocation) |
    |12. Reschedule renewal timer       |
    |                                   |
```

**Key difference from Flow 2:** The renewal request is authenticated by the service's current certificate (via mTLS), not by a bootstrap token. This proves the requester already holds a valid identity.

**Step 10 -- Hot-swap detail:**

The service maintains two TLS contexts briefly:

- New cert is loaded into the server's TLS config.
- In-flight connections on the old cert continue until they close naturally.
- No connections are dropped during the swap.

**Failure modes:**

| Failure                         | Symptom                  | Recovery                                                                                       |
| :------------------------------ | :----------------------- | :--------------------------------------------------------------------------------------------- |
| CA unreachable                  | `ECONNREFUSED` / timeout | Retry with exponential backoff; service continues operating with current cert until it expires |
| Current cert already expired    | 401 from CA              | Fall back to bootstrap token flow (Flow 2)                                                     |
| Identity denied between renewal | 403 from CA              | Service operates on current cert until expiry, then goes offline                               |
| New cert fails validation       | Chain validation error   | Keep using current cert, log error, retry at next interval                                     |

**Operator visibility:** Renewal attempts logged at INFO. Failures logged at WARN (first attempt) and ERROR (if current cert has <10% lifetime remaining). Metric: `pki_cert_renewal_seconds_remaining` gauge.

---

## Flow 4: RFC 8705 Certificate-Bound Token Minting

**Trigger:** A service (Node A) needs to create a peer token for Node B that is bound to Node B's certificate.

**RFC 8705 reference:** Section 3 (Mutual-TLS Client Certificate-Bound Access Tokens), Section 3.1 (JWT Certificate Thumbprint Confirmation Method).

**Components:** Node A (Auth Service), Node B (certificate holder).

```
Node A (Issuer)                  Node A Auth Service
    |                                   |
    | 1. Obtain Node B's cert           |
    |    (out-of-band or via            |
    |     peer discovery)               |
    | 2. Compute SHA-256 thumbprint     |
    |    of Node B's DER-encoded cert   |
    |    (RFC 8705 Section 3.1)         |
    | 3. Base64url-encode thumbprint    |
    |    (no padding, per RFC 4648)     |
    | 4. RPC: tokens.create() --------->|
    |    {                              |
    |      subject: "node-b...",        |
    |      entity: {                    |
    |        id: "node-b...",           |
    |        name: "Node B",            |
    |        type: "service",           |
    |        nodeId: "node-a..."        |
    |      },                           |
    |      principal: "CATALYST::NODE", |
    |      certificateFingerprint:      |
    |        "<base64url-SHA256>",      |
    |      sans: ["spiffe://..."]       |
    |    }                              |
    |                                   |
    |             5. Auth service calls LocalTokenManager.mint():
    |                - Injects cnf claim into JWT payload:
    |                  cnf: { "x5t#S256": "<base64url-SHA256>" }
    |                - Signs JWT with ES384 key (NOT the X.509 CA key)
    |                - Records token in TokenStore with cfn field
    |                                   |
    | 6. Response: signed JWT <---------|
    |                                   |
    | 7. Transmit token to Node B       |
    |    (out-of-band or peering API)   |
    |                                   |
```

**JWT payload produced (step 5):**

```json
{
  "sub": "node-b.somebiz.local.io",
  "iss": "node-a.somebiz.local.io",
  "iat": 1739448000,
  "exp": 1739534400,
  "jti": "a1b2c3d4-e5f6-...",
  "entity": {
    "id": "node-b.somebiz.local.io",
    "name": "Node B",
    "type": "service",
    "nodeId": "node-a.somebiz.local.io"
  },
  "principal": "CATALYST::NODE",
  "cnf": {
    "x5t#S256": "Rvc6LtXrtcjJsf0zZacc2MCETnUOWu59cz3H4ohh4-o"
  }
}
```

**Existing code path:** `packages/authorization/src/jwt/local/index.ts:28-33` -- the `mint()` method checks `options.certificateFingerprint` and injects the `cnf` claim:

```typescript
if (options.certificateFingerprint) {
  claims.cnf = {
    'x5t#S256': options.certificateFingerprint,
  }
}
```

**Critical separation:** The JWT is signed by the `PersistentLocalKeyManager` ES384 key. The X.509 certificate is signed by the Services CA P-384 key. These are completely independent key pairs. The `cnf` claim creates a _reference_ from the JWT domain to the X.509 domain, but the signing keys never cross.

**Failure modes:**

| Failure                          | Error                         | Operator Action                      |
| :------------------------------- | :---------------------------- | :----------------------------------- |
| Node B cert not yet available    | Cannot compute fingerprint    | Complete cert exchange first         |
| Fingerprint computation error    | `Error: Invalid DER encoding` | Verify cert is valid X.509           |
| Token factory not initialized    | `Error: Not initialized`      | Wait for auth service initialization |
| Admin token required for minting | `Permission denied`           | Use system token or ADMIN principal  |

---

## Flow 5: RFC 8705 Certificate-Bound Token Verification

**Trigger:** Node A receives a connection from Node B presenting a peer token and a TLS client certificate.

**RFC 8705 reference:** Section 3 (binding verification), Section 3.1 (thumbprint computation), Section 6.2 (resource server validation), Section 7.2 (security -- hash collision resistance).

**Components:** Node A (verifier/protected resource), TLS layer, Auth Service.

```
Node B (Client)                  Node A (Protected Resource)
    |                                   |
    | 1. mTLS handshake:               |
    |    Present client certificate --->|
    |                                   |
    |         2. TLS layer validates Node B's cert:
    |            a. Signature chain: leaf -> Services CA -> Root CA
    |            b. Certificate not expired
    |            c. Basic Constraints: CA:FALSE
    |            d. Extended Key Usage includes clientAuth
    |            e. Extract SPIFFE URI from SAN:
    |               spiffe://catalyst.example.com/orchestrator/node-b...
    |                                   |
    | 3. Send peer token in RPC call -->|
    |    getIBGPClient(peerToken)       |
    |                                   |
    |         4. Verify JWT signature (ES384):
    |            - Use PersistentLocalKeyManager.verify()
    |            - Match kid from JWT header to managed keys
    |            - Algorithms restricted to [ES384]
    |                                   |
    |         5. Check token revocation:
    |            - TokenStore.isRevoked(jti)
    |                                   |
    |         6. RFC 8705 cnf binding check:
    |            a. Extract cnf.x5t#S256 from JWT payload
    |            b. Compute SHA-256 of Node B's TLS client cert (DER)
    |            c. Base64url-encode the computed hash
    |            d. Compare: jwt.cnf["x5t#S256"] === computed_hash
    |            e. MUST be constant-time comparison
    |                                   |
    |         7. SPIFFE identity check:
    |            a. Extract SPIFFE URI from cert SAN
    |            b. Verify it matches jwt.sub or jwt.entity.id
    |            c. Verify SPIFFE trust domain matches local config
    |                                   |
    |         8. Cedar policy check:
    |            - permissions.authorizeAction({
    |                action: "IBGP_CONNECT",
    |                nodeContext: { nodeId, domains }
    |              })
    |                                   |
    | 9. Connection accepted <----------|
    |    or rejected with error         |
    |                                   |
```

**Step 6 -- cnf binding verification detail (RFC 8705 Section 3.1):**

The thumbprint is computed as:

1. Take the client's X.509 certificate as presented during the TLS handshake.
2. DER-encode the certificate (not PEM -- strip headers and base64-decode).
3. Compute SHA-256 hash of the DER bytes.
4. Base64url-encode the hash (no padding).
5. Compare to the `cnf.x5t#S256` value in the JWT.

Per RFC 8705 Section 7.2: "It relies on the hash function having sufficient second-preimage resistance so as to make it computationally infeasible to find or create another certificate that produces the same hash output value."

**Validation order matters:** The steps must execute in this order for security:

1. **TLS first** -- certificate chain validation happens at the TLS layer before any application logic.
2. **JWT signature** -- cryptographic verification before trusting any claims.
3. **Revocation** -- check before using claims for authorization.
4. **cnf binding** -- the core RFC 8705 check that ties the token to the certificate.
5. **SPIFFE identity** -- application-level identity verification.
6. **Cedar policy** -- authorization (is this identity allowed to perform this action?).

**Failure modes:**

| Step | Failure                 | Error to Caller                       | Log Level |
| :--- | :---------------------- | :------------------------------------ | :-------- |
| 2a   | Cert chain broken       | TLS handshake failure (no app error)  | WARN      |
| 2b   | Cert expired            | TLS handshake failure                 | WARN      |
| 2d   | Missing clientAuth EKU  | TLS handshake failure                 | WARN      |
| 4    | JWT signature invalid   | `Invalid token`                       | WARN      |
| 4    | Unknown kid             | `Invalid token: Key not found`        | WARN      |
| 5    | Token revoked           | `Invalid token: Token is revoked`     | INFO      |
| 6d   | cnf thumbprint mismatch | `Token not bound to this certificate` | ERROR     |
| 6    | No cnf claim in token   | `Token missing certificate binding`   | ERROR     |
| 7    | SPIFFE URI mismatch     | `Identity mismatch`                   | ERROR     |
| 7c   | Wrong trust domain      | `Foreign trust domain rejected`       | WARN      |
| 8    | Cedar policy denied     | `Permission denied`                   | INFO      |

**cnf mismatch is always ERROR** -- it indicates either a stolen token being replayed with a different certificate, or a configuration error where the wrong token was issued.

---

## Flow 6: Orchestrator-to-Orchestrator Peering with mTLS + cnf

**Trigger:** Node A wants to establish a peering session with Node B.

**Components:** Orchestrator A, Orchestrator B, Auth Service A, Auth Service B.

This flow combines Flows 2, 4, and 5 into a complete end-to-end peering sequence.

```
+===========================================================================+
|  PHASE 1: Pre-requisites (both nodes already bootstrapped)                |
+===========================================================================+

  Both nodes have:
  - A valid orchestrator SVID (Flow 2)
  - A running auth service with initialized PKI (Flow 1)
  - Trust bundles containing: Services CA cert + Root CA cert

+===========================================================================+
|  PHASE 2: Certificate Exchange (out-of-band)                              |
+===========================================================================+

  Operator or CLI:
  1. Export Node B's orchestrator certificate (public only):
     $ catalyst pki cert export --node node-b.somebiz.local.io

  2. Provide Node B's cert to Node A (config file, API call, or CLI):
     $ catalyst node peer add node-b --cert <path-to-cert.pem>

+===========================================================================+
|  PHASE 3: Token Minting (RFC 8705 Section 3)                              |
+===========================================================================+

  Node A Auth Service:
  3. Compute SHA-256 thumbprint of Node B's cert (DER)
  4. Mint certificate-bound JWT for Node B (Flow 4):
     cnf: { "x5t#S256": "<Node B cert thumbprint>" }
  5. Store as peerToken in orchestrator config

  Node B Auth Service:
  6. (Mirror) Compute thumbprint of Node A's cert
  7. (Mirror) Mint certificate-bound JWT for Node A
  8. Store as peerToken in orchestrator config

+===========================================================================+
|  PHASE 4: Connection Establishment (mTLS + cnf verification)              |
+===========================================================================+

Node A Orchestrator                Node B Orchestrator
    |                                     |
    | 9. Initiate WebSocket to            |
    |    ws://orch-b:3000/rpc             |
    |    with mTLS (present Node A cert)  |
    |                                     |
    |          10. TLS handshake:
    |              - Node B validates Node A cert chain
    |              - Node A validates Node B cert chain
    |              - Both verify: Services CA -> Root CA
    |              - Both extract SPIFFE URIs
    |                                     |
    |11. RPC: getIBGPClient(peerToken) -->|
    |    (peerToken = JWT minted by       |
    |     Node B's auth for Node A,       |
    |     bound to Node A's cert)         |
    |                                     |
    |          12. Node B validates (Flow 5):
    |              a. JWT signature (ES384)
    |              b. Token not revoked
    |              c. cnf.x5t#S256 matches Node A's TLS cert
    |              d. SPIFFE URI: spiffe://.../orchestrator/node-a...
    |              e. Cedar policy: IBGP_CONNECT allowed
    |                                     |
    |13. IBGPClient returned <------------|
    |                                     |
    |14. client.open(nodeInfo) ---------->|
    |                                     |
    |          15. Dispatch: InternalProtocolOpen
    |              - Add Node A to peer list
    |              - Sync routes back to Node A
    |                                     |
    |16. Dispatch: InternalProtocolConnected
    |    - Mark Node B as connected       |
    |    - Sync local routes to Node B    |
    |                                     |
```

**Security properties of this flow:**

- **Mutual authentication:** Both nodes verify each other's certificate chain (step 10).
- **Token binding:** The peer token is useless without the corresponding private key for the bound certificate (RFC 8705 Section 7.2).
- **SPIFFE identity:** Both nodes verify the peer's SPIFFE URI matches the expected orchestrator identity.
- **Defense in depth:** Even if a token is stolen, it cannot be used without the matching certificate private key. Even if a certificate is stolen, the peer token was bound to a specific cert thumbprint.

**Failure modes specific to peering:**

| Phase | Failure                          | Error                                 | Recovery                                 |
| :---- | :------------------------------- | :------------------------------------ | :--------------------------------------- |
| 2     | Operator provides wrong cert     | cnf mismatch at step 12c              | Re-export correct cert, re-mint token    |
| 3     | Auth service down during mint    | `Token factory not initialized`       | Wait for auth service, retry             |
| 4/10  | TLS handshake fails              | `ECONNREFUSED` or cert error          | Check trust bundles on both nodes        |
| 4/12c | cnf thumbprint mismatch          | `Token not bound to this certificate` | Token was minted for wrong cert; re-mint |
| 4/12e | Cedar policy denies IBGP_CONNECT | `Permission denied`                   | Update Cedar policies                    |
| 4/15  | Peer not in configured list      | `Peer not configured on this node`    | Add peer via CLI or API first            |

---

## Flow 7: Envoy Certificate Provisioning via SDS

**Trigger:** Envoy proxy needs TLS certificates for data plane traffic.

**Components:** Envoy Service (xDS control plane), Transport CA (via Auth Service), Envoy Proxy.

```
Envoy Service                    Auth Service          Envoy Proxy
    |                                 |                     |
    | 1. onInitialize():              |                     |
    |    Start xDS ADS server         |                     |
    |                                 |                     |
    | 2. Generate P-384 key pair      |                     |
    |    for envoy proxy identity     |                     |
    | 3. Build CSR:                   |                     |
    |    SAN URI: spiffe://.../       |                     |
    |      envoy/app/{node-id}        |                     |
    | 4. POST /pki/csr/sign --------->|                     |
    |    (request Transport CA cert)  |                     |
    |                                 |                     |
    |              5. Auth service signs with Transport CA   |
    |                 (NOT Services CA)                      |
    |                                 |                     |
    | 6. Receive cert + chain <-------|                     |
    |                                 |                     |
    |                                                       |
    | 7. Build SDS response:                                |
    |    {                                                  |
    |      name: "server_cert",                             |
    |      tls_certificate: {                               |
    |        certificate_chain: <PEM bundle>,               |
    |        private_key: <PEM>                             |
    |      }                                                |
    |    }                                                  |
    |                                                       |
    | 8. Also build validation context:                     |
    |    {                                                  |
    |      name: "validation_context",                      |
    |      validation_context: {                            |
    |        trusted_ca: <Transport CA + Root CA PEM>       |
    |      }                                                |
    |    }                                                  |
    |                                                       |
    |                              Envoy connects via ADS:  |
    |                              9. StreamAggregatedResources
    |                                 Subscribe: SDS type   |
    |                                                       |
    |10. Push SDS response (cert + validation ctx) -------->|
    |                                                       |
    |                              11. Envoy loads cert     |
    |                                  into TLS context     |
    |                                                       |
    | -- At 50% cert lifetime: --                           |
    |                                                       |
    |12. Renewal (Flow 3): get new cert from Transport CA   |
    |13. Push updated SDS response ----------------------->|
    |                              14. Envoy hot-swaps cert |
    |                                  (zero downtime)      |
    |                                                       |
```

**SDS type URL:** `type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.Secret`

**Important:** The Envoy proxy never holds its own private key for the CSR -- the Envoy Service generates the key pair and provisions it via SDS. This is because the Envoy proxy is a separate process (the stock Envoy Docker image) and cannot generate its own CSR.

**Failure modes:**

| Failure                                | Symptom                            | Recovery                                       |
| :------------------------------------- | :--------------------------------- | :--------------------------------------------- |
| Transport CA unavailable               | Envoy service logs CA error        | Start auth service first                       |
| SDS push fails                         | Envoy has no cert, rejects all TLS | Restart envoy-service; Envoy retries           |
| Cert renewal fails                     | Envoy continues with old cert      | Fix CA, envoy-service retries at next interval |
| Wrong CA used (Services not Transport) | Envoy cert rejected by peers       | Verify CSR goes to Transport CA                |

---

## Flow 8: Envoy-to-Envoy mTLS on Transport Mesh

**Trigger:** Application traffic needs to flow between Node A and Node B via Envoy proxies.

**Components:** Envoy Proxy A, Envoy Proxy B (on envoy-mesh network).

```
Envoy Proxy A                    Envoy Proxy B
    |                                 |
    | 1. Receives request on ingress  |
    |    listener (from local app)    |
    |                                 |
    | 2. Route to egress cluster      |
    |    (remote_{channel}_via_{peer})|
    |                                 |
    | 3. Initiate TLS to Proxy B's    |
    |    ingress listener             |
    |    - Present: Envoy A app cert  |
    |      (spiffe://.../envoy/app/   |
    |       node-a...)                |
    |    - Trust: Transport CA bundle |
    |                                 |
    |         4. TLS handshake:
    |            - Proxy B validates Proxy A cert:
    |              chain to Transport CA -> Root CA
    |            - Proxy A validates Proxy B cert:
    |              chain to Transport CA -> Root CA
    |            - Both verify SPIFFE URI is under
    |              spiffe://.../envoy/...
    |            - Key exchange: ECDHE P-384
    |              (Phase 2: X25519+ML-KEM-768 hybrid)
    |                                 |
    | 5. TLS established <------------|
    |    (mutual authentication done) |
    |                                 |
    | 6. Forward application data --->|
    |    (HTTP, gRPC, TCP, GraphQL)   |
    |                                 |
    |         7. Proxy B forwards to local
    |            cluster (local_{channel})
    |            -> downstream service
    |                                 |
```

**Envoy configuration (generated by xDS):**

The transport socket is configured on both the cluster (upstream) and listener (downstream) sides:

```yaml
# On egress cluster (Envoy A -> Envoy B)
transport_socket:
  name: envoy.transport_sockets.tls
  typed_config:
    '@type': type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.UpstreamTlsContext
    common_tls_context:
      tls_certificate_sds_secret_configs:
        - name: 'server_cert'
          sds_config: { ads: {} }
      validation_context_sds_secret_config:
        name: 'validation_context'
        sds_config: { ads: {} }
```

**Network isolation:** The envoy-mesh network is separate from the stack-X-control and orchestrator-mesh networks. Transport CA certs are only valid on the envoy-mesh. Services CA certs are not trusted on this network, and vice versa.

**Failure modes:**

| Failure                    | Symptom                              | Recovery                                   |
| :------------------------- | :----------------------------------- | :----------------------------------------- |
| Proxy B cert expired       | TLS handshake failure                | Envoy service renews cert via SDS          |
| Wrong trust bundle         | `CERTIFICATE_VERIFY_FAILED`          | Verify envoy-mesh uses Transport CA bundle |
| Services CA cert presented | Rejected (not in Transport CA chain) | Reconfigure SDS to use Transport CA cert   |
| Network unreachable        | `ECONNREFUSED`                       | Check envoy-mesh network connectivity      |

---

## Flow 9: Identity Denial (Passive Revocation)

**Trigger:** Operator decides a SPIFFE identity should no longer be trusted.

**Components:** CLI, Auth Service, affected service.

```
Operator (CLI)                   Auth Service            Affected Service
    |                                 |                       |
    | 1. catalyst pki identity deny   |                       |
    |    --spiffe-id spiffe://...     |                       |
    |    /orchestrator/node-b...      |                       |
    |                                 |                       |
    | 2. RPC: pki.denyIdentity() --->|                       |
    |    { spiffeId: "spiffe://..." } |                       |
    |                                 |                       |
    |         3. Auth service:                                |
    |            a. Verify caller is ADMIN                    |
    |            b. Add SPIFFE ID to deny list                |
    |               (SQLite: denied_identities table)         |
    |            c. Log: "Identity denied: <SPIFFE ID>"       |
    |            d. Optionally: revoke all tokens              |
    |               bound to certs with this SPIFFE ID        |
    |                                 |                       |
    | 4. Confirmation <--------------|                       |
    |    { success: true,             |                       |
    |      expiringCerts: [           |                       |
    |        { serial: "...",         |                       |
    |          expiresAt: "..." }     |                       |
    |      ] }                        |                       |
    |                                 |                       |
    |                                 |  -- Time passes --    |
    |                                 |                       |
    |                                 |  5. Affected service's
    |                                 |     cert approaches 50%
    |                                 |     lifetime           |
    |                                 |                       |
    |                                 |  6. Service attempts renewal
    |                                 |     (Flow 3, step 4):
    |                                 |     POST /pki/csr/sign
    |                                 |                       |
    |         7. Auth service checks deny list:               |
    |            SPIFFE ID is denied -> reject CSR             |
    |                                 |                       |
    |                                 |  8. Service receives 403:
    |                                 |     "Identity denied"  |
    |                                 |                       |
    |                                 |  9. Service logs ERROR:
    |                                 |     "Certificate renewal
    |                                 |      denied for SPIFFE ID
    |                                 |      <...>. Current cert
    |                                 |      expires at <time>."
    |                                 |                       |
    |                                 | 10. Current cert expires
    |                                 |     naturally (1 hour max)
    |                                 |                       |
    |                                 | 11. Service can no longer
    |                                 |     authenticate via mTLS
    |                                 |     -> goes offline
    |                                 |                       |
```

**Why passive revocation works:**

With 1-hour default SVIDs, the maximum exposure window after denying an identity is 1 hour (the remaining lifetime of the current certificate). No CRL distribution or OCSP infrastructure is needed. The CA simply refuses to issue new certificates for the denied SPIFFE ID.

**Failure modes:**

| Failure                         | Symptom                                   | Recovery                                                                 |
| :------------------------------ | :---------------------------------------- | :----------------------------------------------------------------------- |
| Operator denies wrong identity  | Legitimate service goes offline           | `catalyst pki identity allow --spiffe-id <...>` to remove from deny list |
| Deny list not replicated        | Multi-CA setups: denied on one, not other | Ensure deny list is shared across CA instances                           |
| Service ignores renewal failure | Continues operating on expired cert       | TLS peers reject expired certs anyway                                    |

---

## Flow 10: CA Bundle Distribution

**Trigger:** A service needs the trust anchor certificates to validate peer connections.

**Components:** Auth Service (CA bundle endpoint), all services.

```
Service                          Auth Service
    |                                 |
    | -- Initial load (at startup): --|
    |                                 |
    | 1. GET /pki/ca/bundle --------->|
    |                                 |
    |         2. Auth service returns:
    |            {
    |              trustDomain: "catalyst.example.com",
    |              servicesBundle: [
    |                <Services CA PEM>,
    |                <Root CA PEM>
    |              ],
    |              transportBundle: [
    |                <Transport CA PEM>,
    |                <Root CA PEM>
    |              ],
    |              version: "v3",
    |              expiresAt: "<earliest CA expiry>"
    |            }
    |                                 |
    | 3. Response <------------------|
    | 4. Load appropriate bundle:     |
    |    - Services use servicesBundle |
    |    - Envoy uses transportBundle |
    | 5. Configure TLS trust store    |
    |                                 |
    | -- Periodic refresh: -----------|
    |                                 |
    | 6. Timer fires (every 5 min)    |
    | 7. GET /pki/ca/bundle --------->|
    |    If-None-Match: "v3"          |
    |                                 |
    |         8a. If unchanged: 304 Not Modified
    |         8b. If changed: 200 with new bundle
    |                                 |
    | 9a. 304: no action              |
    | 9b. 200: hot-swap trust store   |
    |                                 |
```

**Bundle selection logic:**

| Service Type  | Bundle Used       | Network Segment                    |
| :------------ | :---------------- | :--------------------------------- |
| Orchestrator  | `servicesBundle`  | stack-X-control, orchestrator-mesh |
| Auth          | `servicesBundle`  | stack-X-control                    |
| Node          | `servicesBundle`  | stack-X-control                    |
| Gateway       | `servicesBundle`  | stack-X-control                    |
| Envoy Service | `transportBundle` | stack-X-control (for SDS)          |
| Envoy Proxy   | (via SDS, Flow 7) | envoy-mesh                         |

**Failure modes:**

| Failure                        | Symptom                             | Recovery                                             |
| :----------------------------- | :---------------------------------- | :--------------------------------------------------- |
| Auth service unreachable       | Service starts with no trust bundle | Retry with backoff; fail startup if no cached bundle |
| Stale bundle after CA rotation | New certs rejected (unknown CA)     | Refresh interval catches up within 5 min             |
| Bundle endpoint returns error  | 500 from /pki/ca/bundle             | Service continues with cached bundle                 |

---

## Flow 11: Intermediate CA Rotation

**Trigger:** Intermediate CA approaching expiry (triggered ~6 months before 2-year expiry).

**Components:** Operator (CLI), Auth Service, Root CA (offline/HSM), all services.

```
Operator                 Auth Service          Root CA (offline)
    |                         |                      |
    | 1. catalyst pki ca      |                      |
    |    rotate-intermediate  |                      |
    |    --ca services        |                      |
    |                         |                      |
    |         2. Auth service:                       |
    |            a. Generate new P-384 key pair       |
    |            b. Create CSR for new Services CA    |
    |            c. Export CSR as PEM                 |
    |                         |                      |
    | 3. CSR exported <-------|                      |
    |    (file: services-ca-  |                      |
    |     new.csr.pem)        |                      |
    |                         |                      |
    | 4. Transport CSR to     |                      |
    |    offline Root CA      |                      |
    |    (USB, secure channel)|                      |
    |                         |                      |
    |                   5. Sign CSR with Root CA ---->|
    |                      (offline ceremony)         |
    |                                                 |
    |                   6. New cert produced <---------|
    |                      (services-ca-new.cert.pem) |
    |                         |                      |
    | 7. Import signed cert:  |                      |
    |    catalyst pki ca      |                      |
    |    import-intermediate  |                      |
    |    --cert services-ca-  |                      |
    |    new.cert.pem         |                      |
    |                         |                      |
    | 8. RPC: pki.importCA() ->                      |
    |                         |                      |
    |         9. Auth service:
    |            a. Verify new cert chains to Root CA
    |            b. Verify new cert has pathlen:0
    |            c. Store new Services CA as "active"
    |            d. Keep old Services CA as "retiring"
    |            e. Update CA bundle:
    |               both CAs included in bundle
    |                         |
    | 10. Confirmation <------|
    |                         |
    |     -- Grace period (services refresh bundles): --
    |                         |
    |         11. New SVIDs signed by new Services CA
    |         12. Old SVIDs (signed by old CA) expire
    |             naturally within 1 hour
    |         13. After all old SVIDs expired:
    |             old Services CA removed from bundle
    |                         |
```

**Grace period detail:**

During rotation, both the old and new intermediate CAs are included in the CA bundle. This ensures:

- Existing SVIDs (signed by old CA) continue to validate.
- New SVIDs (signed by new CA) also validate.
- After 1 hour (max SVID lifetime), all old SVIDs have expired.
- The old CA can be safely removed from the bundle.

**Failure modes:**

| Failure                        | Symptom                           | Recovery                                             |
| :----------------------------- | :-------------------------------- | :--------------------------------------------------- |
| New cert doesn't chain to Root | Import rejected: chain validation | Re-sign CSR with correct Root CA                     |
| Old CA removed too early       | In-flight SVIDs rejected          | Re-add old CA to bundle temporarily                  |
| Root CA key unavailable        | Cannot sign new intermediate CSR  | Access offline Root CA (may require physical access) |

---

## Flow 12: Emergency Compromise Response

**Trigger:** A service's private key is believed compromised.

**Components:** Operator, Auth Service, all affected services and peers.

```
+===========================================================================+
| PHASE 1: Immediate Response (minutes)                                     |
+===========================================================================+

Operator                         Auth Service
    |                                 |
    | 1. Assess scope:                |
    |    - Which key is compromised?  |
    |    - Service SVID key?          |
    |    - Intermediate CA key?       |
    |    - Root CA key?               |
    |                                 |
    | -- If SERVICE SVID key: --------|
    |                                 |
    | 2. catalyst pki identity deny   |
    |    --spiffe-id <compromised>    |
    |                         ------->|
    |                                 |
    |         3. SPIFFE ID added to deny list
    |            (Flow 9)
    |                                 |
    | 4. Optionally revoke all tokens |
    |    bound to this cert:          |
    |    catalyst auth token revoke   |
    |    --cert-fingerprint <fp>      |
    |                         ------->|
    |                                 |
    |         5. All tokens with matching cfn revoked
    |                                 |
    | -- Maximum exposure: 1 hour ----|
    | (current SVID expires naturally)|
    |                                 |

+===========================================================================+
| PHASE 1b: If INTERMEDIATE CA key compromised                              |
+===========================================================================+

Operator                         Auth Service         All Services
    |                                 |                     |
    | 6. Remove compromised CA from   |                     |
    |    trust bundle:                |                     |
    |    catalyst pki ca revoke       |                     |
    |    --ca services                |                     |
    |                         ------->|                     |
    |                                 |                     |
    |         7. Auth service:                              |
    |            a. Remove Services CA from active bundle    |
    |            b. Push updated bundle via /pki/ca/bundle   |
    |                                 |                     |
    |                                 |  8. Services refresh
    |                                 |     bundle (5 min max)
    |                                 |                     |
    |                                 |  9. All certs signed by
    |                                 |     compromised CA now
    |                                 |     rejected
    |                                 |                     |
    |                                 | 10. Services lose their
    |                                 |     identities (cannot
    |                                 |     renew via old CA)
    |                                 |                     |
    | -- PHASE 2: Recovery ----------|                     |
    |                                 |                     |
    |11. Rotate intermediate CA       |                     |
    |    (Flow 11)                    |                     |
    |                                 |                     |
    |12. Re-bootstrap all services    |                     |
    |    with new bootstrap tokens    |                     |
    |    (Flow 2)                     |                     |
    |                                 |                     |

+===========================================================================+
| PHASE 1c: If ROOT CA key compromised (catastrophic)                       |
+===========================================================================+

    This is a complete trust hierarchy rebuild:
    1. Generate new Root CA (new key pair, new cert)
    2. Sign new intermediate CAs with new Root CA
    3. Distribute new Root CA cert to ALL nodes (out-of-band)
    4. Re-bootstrap ALL services with new certificates
    5. Re-mint ALL peer tokens
    6. This is a planned outage event

```

**Time-to-containment:**

| Compromised Component | Containment Time | Mechanism                       |
| :-------------------- | :--------------- | :------------------------------ |
| Service SVID key      | 0-60 minutes     | Deny identity + natural expiry  |
| Intermediate CA key   | 0-5 minutes      | Trust bundle update + refresh   |
| Root CA key           | Hours to days    | Full hierarchy rebuild (outage) |

---

## Flow 13: New Node Joining the Cluster

**Trigger:** A new node (Node C) is being added to an existing two-node cluster (A, B).

**Components:** Node C (all services), Auth Service, existing nodes A and B.

```
+===========================================================================+
| PHASE 1: Infrastructure Bootstrap                                         |
+===========================================================================+

Operator:
  1. Deploy Node C containers:
     auth-c, orchestrator-c, envoy-svc-c, envoy-proxy-c
  2. Configure environment:
     CATALYST_NODE_ID=node-c.somebiz.local.io
     CATALYST_BOOTSTRAP_TOKEN=<token-from-auth-a-or-new>
     CATALYST_DOMAINS=somebiz.local.io
     CATALYST_AUTH_ENDPOINT=ws://auth:5000/rpc

+===========================================================================+
| PHASE 2: Auth Service Bootstrap (Flow 1 if new CA, or connect to existing)|
+===========================================================================+

  3. Auth-C starts:
     a. If standalone CA: Initialize own Root CA + intermediates (Flow 1)
     b. If shared CA model: Connect to existing CA and obtain signing authority
  4. Mint system token for Node C

+===========================================================================+
| PHASE 3: Service Certificate Bootstrap                                    |
+===========================================================================+

  5. Orchestrator-C starts:
     a. Generate key pair
     b. Submit CSR to Auth-C (Flow 2):
        SPIFFE: spiffe://catalyst.example.com/orchestrator/node-c.somebiz.local.io
     c. Receive SVID + chain
     d. Configure mTLS server

  6. Envoy-Service-C starts:
     a. Generate key pair for envoy proxy
     b. Submit CSR to Auth-C for Transport CA cert (Flow 7):
        SPIFFE: spiffe://catalyst.example.com/envoy/app/node-c.somebiz.local.io
     c. Receive SVID + chain
     d. Push cert to Envoy Proxy C via SDS

  7. Envoy-Proxy-C receives cert via SDS:
     a. Load cert into TLS context
     b. Ready for envoy-mesh connections

+===========================================================================+
| PHASE 4: Trust Bundle Exchange                                            |
+===========================================================================+

  8. Node C obtains trust bundles from Auth-C (Flow 10):
     - servicesBundle: [Services CA, Root CA]
     - transportBundle: [Transport CA, Root CA]

  9. If Node C has a different Root CA than Nodes A/B:
     a. Exchange Root CA certs between clusters
     b. Update trust bundles on ALL nodes to include foreign Root CA
     c. This is the federation path (ADR 0011 Section 10.5)

+===========================================================================+
| PHASE 5: Peering Establishment                                            |
+===========================================================================+

  10. Export Node C's orchestrator cert:
      $ catalyst pki cert export --node node-c.somebiz.local.io

  11. On Node A (via CLI or API):
      a. Import Node C's cert
      b. Mint cert-bound token for Node C (Flow 4)
      c. Add peer: catalyst node peer add node-c --endpoint ws://orch-c:3000/rpc

  12. On Node C:
      a. Import Node A's cert
      b. Mint cert-bound token for Node A
      c. Add peer: catalyst node peer add node-a --endpoint ws://orch-a:3000/rpc

  13. Peering handshake (Flow 6):
      a. Node A initiates mTLS connection to Node C
      b. Both verify certs + cnf-bound tokens
      c. BGP session established
      d. Routes synced

  14. Repeat steps 11-13 for Node B <-> Node C peering

+===========================================================================+
| PHASE 6: Verification                                                     |
+===========================================================================+

  15. Verify cluster health:
      $ catalyst node peer list
      Expected: node-a (connected), node-b (connected), node-c (connected)

  16. Verify route propagation:
      $ catalyst node route list
      Expected: local routes + internal routes from all peers

  17. Verify Envoy mesh:
      Traffic from Node A can reach Node C's services via envoy-proxy-a -> envoy-proxy-c

```

**Total time for new node join:** Approximately 2-5 minutes for automated steps (phases 2-4), plus operator time for peering setup (phase 5).

**Failure modes specific to new node join:**

| Phase | Failure                    | Error                             | Recovery                                |
| :---- | :------------------------- | :-------------------------------- | :-------------------------------------- |
| 2     | Bootstrap token rejected   | `Invalid token` / `Token expired` | Generate fresh bootstrap token          |
| 3     | CSR rejected (unknown CA)  | `Signing CA not initialized`      | Wait for auth-c to complete init        |
| 4     | Trust bundle incompatible  | Different Root CAs                | Exchange Root CAs (federation path)     |
| 5     | Cert not accepted by peers | `CERTIFICATE_VERIFY_FAILED`       | Verify all nodes have same trust bundle |
| 5     | cnf mismatch               | `Token not bound to certificate`  | Re-mint tokens with correct cert        |

---

## Flow 14: CLI Operations End-to-End

### 14.1: `catalyst pki init`

**Purpose:** Initialize the PKI CA hierarchy on a fresh auth service.

```
Operator                         CLI                  Auth Service
    |                               |                      |
    | $ catalyst pki init           |                      |
    |                               |                      |
    |         1. CLI connects to auth service RPC          |
    |            (ws://<auth-endpoint>/rpc)                 |
    |         2. Authenticate with system token             |
    |                               |                      |
    |         3. RPC: pki.initialize() ------------------->|
    |            { trustDomain: "catalyst.example.com" }    |
    |                               |                      |
    |                  4. Auth service executes Flow 1      |
    |                     (Root CA + 2 intermediates)       |
    |                               |                      |
    |         5. Response <----------------------------|
    |            { success: true,                          |
    |              rootFingerprint: "A4Dt...",              |
    |              servicesCaFingerprint: "bwcK...",        |
    |              transportCaFingerprint: "Rvc6..." }      |
    |                               |                      |
    | Output:                       |                      |
    |   PKI initialized.            |                      |
    |   Root CA:       A4Dt...      |                      |
    |   Services CA:   bwcK...      |                      |
    |   Transport CA:  Rvc6...      |                      |
    |                               |                      |
```

**Failure:** If PKI already initialized, returns `{ success: false, error: "PKI already initialized" }`. Operator sees: `Error: PKI already initialized. Use --force to reinitialize (destroys existing CA).`

### 14.2: `catalyst pki cert generate`

**Purpose:** Manually generate an end-entity certificate for a service.

```
Operator                         CLI                  Auth Service
    |                               |                      |
    | $ catalyst pki cert generate  |                      |
    |   --service-type orchestrator |                      |
    |   --node-id node-a...         |                      |
    |   --output /path/to/cert.pem  |                      |
    |                               |                      |
    |         1. CLI generates P-384 key pair locally      |
    |         2. CLI builds CSR with SPIFFE SAN:           |
    |            spiffe://catalyst.example.com/             |
    |              orchestrator/node-a...                   |
    |         3. RPC: pki.signCsr() ---------------------->|
    |            { csr: <PEM>,                             |
    |              serviceType: "orchestrator",             |
    |              nodeId: "node-a..." }                    |
    |                               |                      |
    |                  4. Auth service validates + signs    |
    |                     (Flow 2, steps 5-7)              |
    |                               |                      |
    |         5. Response: { certificate: <PEM>, chain }   |
    |                               |                      |
    |         6. CLI writes cert to --output path          |
    |         7. CLI writes private key to                 |
    |            --output path with .key extension         |
    |                               |                      |
    | Output:                       |                      |
    |   Certificate written to:     |                      |
    |     /path/to/cert.pem         |                      |
    |   Private key written to:     |                      |
    |     /path/to/cert.key         |                      |
    |   SPIFFE ID:                  |                      |
    |     spiffe://catalyst.        |                      |
    |       example.com/            |                      |
    |       orchestrator/node-a...  |                      |
    |   Expires: 2026-02-13T14:30Z  |                      |
    |   Fingerprint: Rvc6...        |                      |
    |                               |                      |
```

### 14.3: `catalyst pki identity deny`

**Purpose:** Deny a SPIFFE identity (passive revocation).

```
Operator                         CLI                  Auth Service
    |                               |                      |
    | $ catalyst pki identity deny  |                      |
    |   --spiffe-id spiffe://...    |                      |
    |   /orchestrator/node-b...     |                      |
    |                               |                      |
    |         1. CLI confirms with operator:               |
    |            "Deny identity spiffe://...?              |
    |             This will prevent certificate renewal.   |
    |             Current certs expire within 1 hour.      |
    |             Type 'yes' to confirm:"                  |
    |                               |                      |
    | yes                           |                      |
    |                               |                      |
    |         2. RPC: pki.denyIdentity() ---------------->|
    |            { spiffeId: "spiffe://..." }              |
    |                               |                      |
    |                  3. Flow 9 executes                  |
    |                               |                      |
    |         4. Response: { success, expiringCerts }      |
    |                               |                      |
    | Output:                       |                      |
    |   Identity denied.            |                      |
    |   Active certificates:        |                      |
    |     Serial: ABC123            |                      |
    |     Expires: 2026-02-13T14:30Z|                      |
    |   All tokens bound to this    |                      |
    |   identity have been revoked. |                      |
    |                               |                      |
```

### 14.4: `catalyst pki status`

**Purpose:** Show PKI health and certificate status.

```
$ catalyst pki status

PKI Status: HEALTHY
Trust Domain: catalyst.example.com

CA Hierarchy:
  Root CA
    Fingerprint:  A4DtL2JmUM...
    Expires:      2036-02-13 (9 years, 364 days)
    Algorithm:    ECDSA P-384

  Services CA
    Fingerprint:  bwcK0esc3A...
    Expires:      2028-02-13 (1 year, 364 days)
    Algorithm:    ECDSA P-384
    Issued certs: 12 active

  Transport CA
    Fingerprint:  Rvc6LtXrtc...
    Expires:      2028-02-13 (1 year, 364 days)
    Algorithm:    ECDSA P-384
    Issued certs: 3 active

Active SVIDs:
  spiffe://.../orchestrator/node-a...  expires in 45m  [OK]
  spiffe://.../orchestrator/node-b...  expires in 22m  [OK]
  spiffe://.../auth/auth-a             expires in 38m  [OK]
  spiffe://.../envoy/app/node-a...     expires in 51m  [OK]

Denied Identities: 0

Warnings: none
```

**Failure indicators in status output:**

```
PKI Status: DEGRADED

Warnings:
  [WARN] Services CA expires in 5 months (rotate recommended)
  [WARN] 2 SVIDs failed renewal in last hour
  [CRIT] Root CA expires in 6 months (rotation ceremony required)

Failed Renewals:
  spiffe://.../orchestrator/node-c...  last attempt: 5m ago  error: CA unreachable
```

---

## Appendix A: RFC 8705 Section Reference Map

This table maps each Catalyst PKI flow to the relevant RFC 8705 sections.

| Catalyst Flow                 | RFC 8705 Section | RFC 8705 Concept                           |
| :---------------------------- | :--------------- | :----------------------------------------- |
| Flow 4 (cert-bound minting)   | Section 3        | Certificate-bound access token issuance    |
| Flow 4, step 5 (cnf claim)    | Section 3.1      | JWT Certificate Thumbprint Confirmation    |
| Flow 5 (token verification)   | Section 6.2      | Resource server validation                 |
| Flow 5, step 6 (hash compare) | Section 3.1      | x5t#S256 thumbprint comparison             |
| Flow 5 (security)             | Section 7.2      | Certificate thumbprint binding security    |
| Flow 6, step 10 (mTLS)        | Section 2.1      | PKI Mutual-TLS Method                      |
| Flow 6, step 12c (binding)    | Section 3        | Binding verification at protected resource |
| Flow 3 (cert expiry + token)  | Section 6.3      | Certificate expiration and bound tokens    |

## Appendix B: Data Flow Summary

```
+-----------------------------------------------------------------------+
|                        DATA FLOW SUMMARY                              |
|                                                                       |
|  Bootstrap token    ─────>  Auth Service  ─────>  SVID (X.509)        |
|  (JWT, short-lived)         (CA endpoint)         (1-hour cert)       |
|                                                                       |
|  Service cert       ─────>  Auth Service  ─────>  cnf-bound JWT       |
|  (X.509 thumbprint)         (token factory)       (peer token)        |
|                                                                       |
|  cnf-bound JWT      ─────>  Orchestrator  ─────>  Peering session     |
|  + mTLS client cert         (verifier)            (authenticated)     |
|                                                                       |
|  Transport CA cert  ─────>  Envoy Service ─────>  SDS push           |
|  (signed by CA)             (xDS server)          (to Envoy proxy)    |
|                                                                       |
|  Trust bundle       ─────>  All services  ─────>  TLS trust store     |
|  (CA chain PEMs)            (periodic GET)        (validates peers)   |
+-----------------------------------------------------------------------+
```
