# PKI Operations Guide

This guide covers day-to-day operations, troubleshooting, and monitoring for
the Catalyst PKI system. It assumes familiarity with the architecture described
in [ADR 0011](../adr/0011-pki-hierarchy-and-certificate-profiles.md).

---

## Table of Contents

1. [Common Failure Modes and Diagnosis](#1-common-failure-modes-and-diagnosis)
2. [Operational Procedures](#2-operational-procedures)
3. [CLI Cheat Sheet](#3-cli-cheat-sheet)
4. [Logging and Observability](#4-logging-and-observability)
5. [Environment-Specific Guidance](#5-environment-specific-guidance)

---

## 1. Common Failure Modes and Diagnosis

### 1.1 Certificate Expired (Renewal Failed)

**Symptoms:**

- Service logs show TLS handshake failures
- Peer connections drop with `certificate has expired` errors
- Health checks start failing on mTLS-protected endpoints

**Example log output (service side):**

```
09:14:22.381 ERROR   catalyst.orchestrator: TLS handshake failed: certificate has expired
  {"peer":"node-b.somebiz.local.io","spiffe_id":"spiffe://catalyst.example.com/orchestrator/node-a.somebiz.local.io","expired_at":"2026-02-13T09:14:00.000Z"}
09:14:22.382 ERROR   catalyst.pki: Certificate renewal failed — service operating with expired certificate
  {"fingerprint":"a1b2c3...","remaining_ttl_seconds":-22,"last_renewal_attempt":"2026-02-13T09:13:55.000Z"}
```

**Diagnosis:**

1. Check the service logs for renewal failure messages:
   ```bash
   # Look for renewal failures in the last hour
   docker logs <container> 2>&1 | grep -i "renewal failed\|certificate expired\|renewal error"
   ```
2. Verify the auth service (CA) is reachable from the affected service:
   ```bash
   # From the affected container
   curl -s http://auth:4020/health
   ```
3. Check the current certificate expiry:
   ```bash
   catalyst pki cert list --auth-url ws://localhost:4020/rpc --token "$CATALYST_AUTH_TOKEN"
   ```

**Fix:**

- If the CA is reachable: restart the affected service. It will re-bootstrap
  with a fresh CSR and obtain a new certificate.
- If the CA is unreachable: fix CA connectivity first, then restart the service.
- For recurring failures: increase the SVID TTL via `CATALYST_PKI_SVID_TTL`
  to give the renewal loop more runway (e.g., `14400` for 4 hours).

---

### 1.2 CA Unreachable During Renewal

**Symptoms:**

- Services continue operating with their current certificate (still valid)
- Warning logs appear with increasing urgency as certificate lifetime decreases
- No new certificates are issued; `cert_renewal_failure_total` metric increments

**Example log output:**

```
08:30:05.112 WARN    catalyst.pki: Certificate renewal attempt failed — CA unreachable
  {"attempt":1,"auth_url":"ws://auth:4020/rpc","error":"WebSocket connection refused","cert_expires_in_seconds":1795}
08:35:05.118 WARN    catalyst.pki: Certificate renewal attempt failed — CA unreachable
  {"attempt":2,"auth_url":"ws://auth:4020/rpc","error":"WebSocket connection refused","cert_expires_in_seconds":1495}
08:45:05.203 ERROR   catalyst.pki: Certificate renewal critical — less than 25% lifetime remaining
  {"attempt":4,"cert_expires_in_seconds":895,"cert_fingerprint":"d4e5f6..."}
```

**Timeline for default 1-hour SVID TTL:**

| Time    | Event                                                                  |
| :------ | :--------------------------------------------------------------------- |
| T+0     | Certificate issued (valid for 1 hour)                                  |
| T+30min | Renewal triggered (50% lifetime). If CA is down, first warning logged. |
| T+35min | Retry #2. Warning logged.                                              |
| T+40min | Retry #3. Warning logged.                                              |
| T+45min | Retry #4. ERROR logged (25% lifetime).                                 |
| T+55min | Retry #6. CRITICAL logged (< 5 minutes remaining).                     |
| T+60min | Certificate expires. TLS connections fail.                             |

**Fix:**

- Restore CA (auth service) connectivity. The renewal loop will automatically
  pick up and obtain a new certificate on the next check cycle (every 5 minutes).
- No service restart needed if the CA comes back before certificate expiry.
- If the certificate has already expired, the service needs a restart
  to re-bootstrap.

**Prevention:**

- Run the auth service with high availability (multiple replicas behind a load balancer).
- For edge deployments with intermittent connectivity, increase SVID TTL:
  ```bash
  CATALYST_PKI_SVID_TTL=14400  # 4 hours — gives 2-hour renewal window
  ```

---

### 1.3 Wrong Trust Domain Configured

**Symptoms:**

- mTLS handshakes fail with "certificate unknown" or "unknown authority"
- Certificates are issued successfully but peers reject them
- SPIFFE ID validation fails during connection establishment

**Example log output:**

```
10:22:15.003 ERROR   catalyst.orchestrator: Peer certificate SPIFFE ID trust domain mismatch
  {"expected_domain":"catalyst.example.com","received_domain":"catalyst.local","peer":"node-b.somebiz.local.io",
   "received_spiffe_id":"spiffe://catalyst.local/orchestrator/node-b.somebiz.local.io"}
```

**Diagnosis:**

1. Check the trust domain configuration on both sides:

   ```bash
   # On the affected node
   echo $CATALYST_PKI_TRUST_DOMAIN

   # Inspect the certificate's SPIFFE URI SAN
   catalyst pki cert list --auth-url ws://localhost:4020/rpc --token "$TOKEN"
   ```

2. Inspect the certificate directly:
   ```bash
   openssl x509 -in /path/to/cert.pem -text -noout | grep URI
   # Expected: URI:spiffe://catalyst.example.com/orchestrator/node-a.somebiz.local.io
   ```

**Fix:**

- Ensure all nodes in the cluster share the same trust domain value in their
  configuration (`CATALYST_PKI_TRUST_DOMAIN`).
- After correcting the trust domain, restart the affected services so they
  obtain new certificates with the correct SPIFFE URIs.
- Update the CA if the trust domain was wrong at the root level (requires
  re-initialization — see [Section 2.1](#21-first-time-setup)).

---

### 1.4 SPIFFE ID Mismatch

**Symptoms:**

- Peer connections rejected despite valid certificates
- Cedar policy evaluation fails because the principal identity does not match
- Logs show authorization denied with SPIFFE-based context

**Example log output:**

```
10:45:33.501 WARN    catalyst.auth: Permission denied for action: IBGP_CONNECT
  {"principal":"spiffe://catalyst.example.com/orchestrator/node-a.somebiz.local.io",
   "expected_principal":"spiffe://catalyst.example.com/orchestrator/node-a",
   "reasons":["policy0: SPIFFE ID does not match trusted identity"]}
```

**Diagnosis:**
The SPIFFE ID path is constructed from the service type and instance/node ID.
Common mismatches:

- Node ID uses short name (`node-a`) but SPIFFE ID expects FQDN (`node-a.somebiz.local.io`)
- Service type segment is wrong (`node` vs `orchestrator`)

Check the node's identity:

```bash
echo $CATALYST_NODE_ID
# Should match what appears in the SPIFFE URI path
```

**Fix:**

- Ensure `CATALYST_NODE_ID` matches the expected FQDN across all services
  on the same node.
- Check that the service type in the SPIFFE URI matches what peers expect.
  Refer to [ADR 0011 Section 1](../adr/0011-pki-hierarchy-and-certificate-profiles.md)
  for the path convention table.

---

### 1.5 cnf Binding Mismatch (Certificate-Bound Token)

**Symptoms:**

- Token verification succeeds but the binding check fails
- Peer is authenticated but the session is rejected with a binding error
- Existing token works with one certificate but not after certificate renewal

**Example log output:**

```
11:02:44.881 WARN    catalyst.auth: Certificate binding mismatch — cnf.x5t#S256 does not match TLS certificate
  {"token_thumbprint":"Rvc6LtXrtcjJsf0zZacc2MCETnUOWu59cz3H4ohh4-o",
   "tls_cert_thumbprint":"Xk9pLmN3qRst4uVw5xYz6aBcDeFgHiJkLmNoPqRsT-U",
   "subject":"node-b","action":"rejected"}
```

**Diagnosis:**
This happens when a certificate-bound token (ADR 0007) references a certificate
that has since been rotated. The `cnf.x5t#S256` claim in the JWT contains the
SHA-256 thumbprint of the certificate that was active when the token was minted.
After certificate renewal, the thumbprint changes.

```bash
# Decode the token to inspect the cnf claim
echo "$TOKEN" | cut -d. -f2 | base64 -d 2>/dev/null | jq '.cnf'
# Output: {"x5t#S256": "Rvc6LtXrtcjJsf0zZacc2MCETnUOWu59cz3H4ohh4-o"}

# Compare with the current certificate's thumbprint
openssl x509 -in /path/to/current-cert.pem -outform DER | openssl dgst -sha256 -binary | base64url
```

**Fix:**

- Mint a new certificate-bound token using the current certificate's fingerprint:
  ```bash
  catalyst auth token mint <subject> \
    --principal NODE \
    --cert-fingerprint "$(openssl x509 -in cert.pem -outform DER | openssl dgst -sha256 -binary | base64url)" \
    --token "$ADMIN_TOKEN" \
    --auth-url ws://localhost:4020/rpc
  ```
- For automated systems: the certificate renewal flow should automatically
  re-mint bound tokens when certificates rotate.

---

### 1.6 Incomplete Certificate Chain

**Symptoms:**

- TLS handshake fails with "unable to verify the first certificate"
- The leaf certificate is valid but the verifier cannot build a path to the root
- Happens most often when intermediate CA certificates are missing from the bundle

**Example log output:**

```
14:30:12.551 ERROR   catalyst.orchestrator: TLS verification failed: unable to get local issuer certificate
  {"peer":"node-b.somebiz.local.io","error":"UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
   "chain_depth":0,"missing":"Catalyst Services CA"}
```

**Diagnosis:**

```bash
# Fetch the CA bundle and check it contains both root and intermediate
catalyst pki ca bundle --auth-url ws://localhost:4020/rpc --token "$TOKEN" > ca-bundle.pem

# Count certificates in the bundle (should be 3: root + 2 intermediates)
grep -c "BEGIN CERTIFICATE" ca-bundle.pem

# Verify a service certificate against the bundle
openssl verify -CAfile ca-bundle.pem /path/to/service-cert.pem
```

**Fix:**

- Re-fetch the CA bundle from the auth service and distribute it to the
  affected services:
  ```bash
  curl -s http://auth:4020/pki/ca/bundle > /etc/catalyst/ca-bundle.pem
  ```
- If using Envoy SDS, the trust bundle is distributed automatically. Restart
  the envoy-service to force a refresh.
- Ensure the service's TLS configuration includes the full chain (leaf +
  intermediate) in its certificate file, not just the leaf.

---

### 1.7 Deny List Blocks Legitimate Renewal

**Symptoms:**

- A specific service cannot renew its certificate while others can
- CSR signing requests are rejected with a "denied" error
- The auth service logs show a deny-list hit

**Example log output:**

```
15:10:33.221 WARN    catalyst.pki: CSR signing denied — identity is on the deny list
  {"spiffe_id":"spiffe://catalyst.example.com/orchestrator/node-a.somebiz.local.io",
   "reason":"compromised — incident #1234","denied_at":"2026-02-12T22:00:00.000Z"}
```

**Diagnosis:**

```bash
# List all denied identities
catalyst pki identity list-denied --auth-url ws://localhost:4020/rpc --token "$ADMIN_TOKEN"
```

**Fix:**

```bash
# Remove the identity from the deny list
catalyst pki identity allow \
  spiffe://catalyst.example.com/orchestrator/node-a.somebiz.local.io \
  --auth-url ws://localhost:4020/rpc \
  --token "$ADMIN_TOKEN"
```

After removing from the deny list, the service's next renewal attempt will
succeed automatically (within 5 minutes).

---

### 1.8 Bootstrap Token Expired

**Symptoms:**

- A new service cannot join the cluster
- First CSR submission is rejected with an authentication error
- The bootstrap token was created too long ago

**Example log output (new service attempting to join):**

```
16:00:15.332 ERROR   catalyst.pki: Bootstrap CSR signing failed — authentication error
  {"error":"Invalid token","auth_url":"ws://auth:4020/rpc",
   "hint":"Bootstrap token may have expired. Generate a new one with: catalyst auth token mint bootstrap --principal ADMIN"}
```

**Diagnosis:**

- Bootstrap tokens have a default TTL of 24 hours (`CATALYST_BOOTSTRAP_TTL`).
- Check when the token was issued by decoding it:
  ```bash
  echo "$CATALYST_BOOTSTRAP_TOKEN" | cut -d. -f2 | base64 -d 2>/dev/null | jq '{iat: .iat, exp: .exp}'
  ```

**Fix:**

1. Mint a new bootstrap token from the auth service:
   ```bash
   catalyst auth token mint bootstrap \
     --principal ADMIN \
     --expires-in 1h \
     --token "$SYSTEM_TOKEN" \
     --auth-url ws://localhost:4020/rpc
   ```
2. Update the new service's configuration with the fresh token:
   ```bash
   export CATALYST_BOOTSTRAP_TOKEN="<new-token>"
   ```
3. Start (or restart) the new service.

---

## 2. Operational Procedures

### 2.1 First-Time Setup

#### Development Environment

For local development, the auth service auto-generates an ephemeral CA on
first boot. No manual PKI setup is required.

```bash
# 1. Set required environment variables
export CATALYST_NODE_ID="dev-node"
export CATALYST_DOMAINS="dev.local"
export CATALYST_PEERING_ENDPOINT="ws://localhost:3000/rpc"

# 2. Start the auth service — CA auto-generates
bun run apps/auth/src/index.ts

# Expected output:
# 09:00:01.234 INFO    catalyst.auth: JWTTokenFactory initialized
# 09:00:01.456 INFO    catalyst.pki: No existing Root CA found — generating ephemeral CA
# 09:00:01.789 INFO    catalyst.pki: Root CA generated {"fingerprint":"abc123...","cn":"Catalyst Root CA","algorithm":"EC-P384","validity":"10 years"}
# 09:00:02.012 INFO    catalyst.pki: Services CA generated {"fingerprint":"def456...","cn":"Catalyst Services CA","signed_by":"abc123..."}
# 09:00:02.234 INFO    catalyst.pki: Transport CA generated {"fingerprint":"ghi789...","cn":"Catalyst Transport CA","signed_by":"abc123..."}
# 09:00:02.456 INFO    catalyst.pki: PKI initialized {"root":"abc123...","intermediates":2,"trust_domain":"catalyst.example.com"}
```

Development defaults:

- SVID TTL: 24 hours (`CATALYST_PKI_SVID_TTL=86400`)
- CA stored in local SQLite (`certs.db`)
- Trust domain: `catalyst.example.com`

#### Production Environment

Production deployments require a deliberate CA initialization ceremony.

```bash
# 1. Initialize the Root CA (do this ONCE, on a secure machine)
catalyst pki init \
  --common-name "Acme Corp Catalyst Root CA" \
  --algorithm EC-P384 \
  --ttl-days 3650 \
  --auth-url ws://auth.internal:4020/rpc \
  --token "$ADMIN_TOKEN"

# 2. Create the Services intermediate CA
catalyst pki ca create-intermediary \
  --common-name "Acme Corp Catalyst Services CA" \
  --ttl-days 730 \
  --auth-url ws://auth.internal:4020/rpc \
  --token "$ADMIN_TOKEN"

# 3. Create the Transport intermediate CA
catalyst pki ca create-intermediary \
  --common-name "Acme Corp Catalyst Transport CA" \
  --ttl-days 730 \
  --auth-url ws://auth.internal:4020/rpc \
  --token "$ADMIN_TOKEN"

# 4. Export and distribute the CA bundle
catalyst pki ca bundle \
  --auth-url ws://auth.internal:4020/rpc \
  --token "$ADMIN_TOKEN" > /etc/catalyst/ca-bundle.pem

# 5. Verify the setup
catalyst pki status \
  --auth-url ws://auth.internal:4020/rpc \
  --token "$ADMIN_TOKEN"

# Expected output:
# PKI Status: HEALTHY
# Root CA:
#   Fingerprint: abc123...
#   Common Name: Acme Corp Catalyst Root CA
#   Algorithm:   EC-P384
#   Expires:     2036-02-13T00:00:00.000Z (3650 days remaining)
# Intermediate CAs: 2
#   - Catalyst Services CA (def456...) expires 2028-02-13 (730 days)
#   - Catalyst Transport CA (ghi789...) expires 2028-02-13 (730 days)
# Active Certificates: 0
# Denied Identities:   0
```

Production settings:

```bash
CATALYST_PKI_SVID_TTL=3600          # 1 hour (default)
CATALYST_PKI_TRUST_DOMAIN=acme.catalyst.io
CATALYST_PKI_CERTS_DB=/data/pki/certs.db
CATALYST_PKI_AUTO_RENEW=true
```

---

### 2.2 Adding a New Node to an Existing Cluster

```bash
# 1. On the new node, set configuration
export CATALYST_NODE_ID="node-c.somebiz.local.io"
export CATALYST_DOMAINS="somebiz.local.io"
export CATALYST_PEERING_ENDPOINT="ws://node-c:3000/rpc"

# 2. Get a bootstrap token from the admin (short-lived)
export CATALYST_BOOTSTRAP_TOKEN="<token from admin>"
export CATALYST_AUTH_URL="ws://auth.internal:4020/rpc"

# 3. Start the service — it will:
#    a. Generate a local key pair
#    b. Create a CSR with SPIFFE ID: spiffe://catalyst.example.com/orchestrator/node-c.somebiz.local.io
#    c. Submit the CSR to the auth service using the bootstrap token
#    d. Receive a signed certificate + chain
#    e. Start the renewal loop
bun run apps/orchestrator/src/index.ts

# 4. Verify the node has a valid certificate
catalyst pki cert list \
  --auth-url ws://auth.internal:4020/rpc \
  --token "$ADMIN_TOKEN" \
  | grep node-c
```

---

### 2.3 Rotating Intermediate CAs

Intermediate CAs have a 2-year lifetime. Rotation should be performed
approximately 6 months before expiry. This is a planned operation, not
an emergency.

**Pre-rotation checklist:**

- [ ] Current intermediate CA has > 30 days remaining (safety margin)
- [ ] All nodes are healthy and reachable
- [ ] Maintenance window scheduled (briefly impacts new certificate issuance)

```bash
# 1. Check current intermediate CA expiry
catalyst pki status --auth-url ws://auth.internal:4020/rpc --token "$ADMIN_TOKEN"

# 2. Create the new intermediate CA (signed by the existing root)
catalyst pki ca create-intermediary \
  --common-name "Acme Corp Catalyst Services CA v2" \
  --ttl-days 730 \
  --auth-url ws://auth.internal:4020/rpc \
  --token "$ADMIN_TOKEN"

# 3. Export the updated CA bundle (now contains old + new intermediates)
catalyst pki ca bundle \
  --auth-url ws://auth.internal:4020/rpc \
  --token "$ADMIN_TOKEN" > /etc/catalyst/ca-bundle.pem

# 4. Distribute the new bundle to all nodes
# (mechanism depends on deployment: volume mount, config push, xDS, etc.)

# 5. Switch the default signing CA to the new intermediate
# (new certificates will be signed by the new CA; old ones remain valid until expiry)

# 6. Monitor: watch for any certificate validation errors in the next hour
docker logs auth 2>&1 | grep -i "error\|warn" | tail -20
```

**Timeline:**

- T-6 months: Create new intermediate, distribute updated bundle
- T-6 months to T-0: Both old and new intermediates are in the trust bundle.
  New certificates are signed by the new CA. Old certificates expire naturally.
- T-0: Old intermediate expires. It has been unused for signing for 6 months.
  Remove it from the trust bundle during the next update.

---

### 2.4 Emergency: Revoking a Compromised Service Identity

If a service identity is compromised, deny its SPIFFE ID to prevent further
certificate issuance. The current certificate will expire within one TTL
period (1 hour by default).

```bash
# 1. Immediately deny the compromised identity
catalyst pki identity deny \
  spiffe://catalyst.example.com/orchestrator/node-a.somebiz.local.io \
  --reason "Key compromise — incident #1234" \
  --auth-url ws://auth.internal:4020/rpc \
  --token "$ADMIN_TOKEN"

# 2. Verify the deny list
catalyst pki identity list-denied \
  --auth-url ws://auth.internal:4020/rpc \
  --token "$ADMIN_TOKEN"

# Expected output:
# SPIFFE ID                                                            Reason                           Denied At
# spiffe://catalyst.example.com/orchestrator/node-a.somebiz.local.io   Key compromise — incident #1234  2026-02-13T16:00:00.000Z

# 3. Monitor: the compromised node's certificate expires within 1 hour
# No further certificates will be issued to this identity

# 4. After remediation, re-enable the identity
catalyst pki identity allow \
  spiffe://catalyst.example.com/orchestrator/node-a.somebiz.local.io \
  --auth-url ws://auth.internal:4020/rpc \
  --token "$ADMIN_TOKEN"
```

**If faster revocation is required (< 1 hour):**

- Stop or isolate the compromised service at the network level (firewall rules,
  security group, container stop).
- Update the trust bundle to exclude the specific certificate serial number
  (pushed via xDS to all Envoy proxies).

---

### 2.5 Migrating from Shared-Secret Peering to mTLS

This is a phased migration. Both mechanisms coexist during the transition.

**Phase 1: Add mTLS alongside shared secret**

```bash
# All nodes keep CATALYST_PEERING_SECRET but also configure PKI
# The system accepts EITHER mechanism during this phase

# On each node:
export CATALYST_PEERING_SECRET="valid-secret"    # Keep existing
export CATALYST_PKI_TRUST_DOMAIN="catalyst.example.com"  # Add PKI
export CATALYST_PEER_AUTH_MODE="both"            # Accept both

# Restart all services
```

**Phase 2: Verify mTLS is working**

```bash
# Check that peers are connecting via mTLS
catalyst pki status --auth-url ws://auth.internal:4020/rpc --token "$ADMIN_TOKEN"

# Look for mTLS connections in logs
docker logs orchestrator 2>&1 | grep "mTLS peer connected"
```

**Phase 3: Remove shared secret**

```bash
# On each node, switch to mTLS-only
export CATALYST_PEER_AUTH_MODE="mtls"
unset CATALYST_PEERING_SECRET

# Restart all services
```

---

### 2.6 Backing Up CA Key Material

CA private keys are the most sensitive material in the system. Loss of the
root CA key means the entire PKI must be rebuilt.

```bash
# 1. Export the CA database (contains encrypted private keys)
cp /data/pki/certs.db /backup/pki/certs-$(date +%Y%m%d).db

# 2. Verify the backup
sqlite3 /backup/pki/certs-$(date +%Y%m%d).db "SELECT fingerprint, common_name, type FROM certificate WHERE type LIKE '%ca%';"

# 3. Store the backup securely
# - Encrypt with GPG or age before storing off-site
# - For production: use AWS KMS / GCP KMS for CA key storage instead of SQLite
#   (configured via CATALYST_PKI_KEY_BACKEND=aws-kms)
```

**Production recommendation:** Use cloud KMS for CA signing keys. The SQLite
database then only contains certificate metadata and public material — the
private keys live in the HSM and never leave it.

---

### 2.7 Monitoring PKI Health

Run periodic health checks:

```bash
# Quick status check
catalyst pki status --auth-url ws://auth.internal:4020/rpc --token "$ADMIN_TOKEN"

# Check for certificates expiring soon (within 2 hours)
catalyst pki cert list --auth-url ws://auth.internal:4020/rpc --token "$ADMIN_TOKEN" \
  | grep -v "root-ca\|intermediate" \
  | awk '$NF < 7200 {print "EXPIRING SOON:", $0}'
```

See [Section 4](#4-logging-and-observability) for metrics and alerting.

---

## 3. CLI Cheat Sheet

### Quick Reference

| Command                                   | Description                                 |
| :---------------------------------------- | :------------------------------------------ |
| `catalyst pki init`                       | Initialize root CA (first-time setup)       |
| `catalyst pki status`                     | Show PKI health and CA info                 |
| `catalyst pki ca create-intermediary`     | Create a new intermediate CA                |
| `catalyst pki ca bundle`                  | Export CA certificate chain (PEM to stdout) |
| `catalyst pki cert generate`              | Generate an end-entity certificate          |
| `catalyst pki cert sign-csr`              | Sign an externally-created CSR              |
| `catalyst pki cert list`                  | List all tracked certificates               |
| `catalyst pki identity deny <spiffe-id>`  | Block certificate issuance for an identity  |
| `catalyst pki identity allow <spiffe-id>` | Re-enable a denied identity                 |
| `catalyst pki identity list-denied`       | Show all denied identities                  |

All commands accept these global options:

```
--auth-url <url>    Auth service RPC URL (default: $CATALYST_AUTH_URL or ws://localhost:4020/rpc)
--token <token>     Admin auth token (default: $CATALYST_AUTH_TOKEN)
```

### Common Workflows

#### Generate a certificate for a service

```bash
# Generate a certificate with a SPIFFE ID
catalyst pki cert generate \
  --common-name "gateway-a" \
  --spiffe-id "spiffe://catalyst.example.com/gateway/gateway-a" \
  --ttl-hours 24 \
  --output-cert ./gateway-cert.pem \
  --output-key ./gateway-key.pem \
  --auth-url ws://localhost:4020/rpc \
  --token "$ADMIN_TOKEN"

# Output:
# [ok] Certificate generated:
#   Fingerprint: abc123...
#   SPIFFE ID:   spiffe://catalyst.example.com/gateway/gateway-a
#   Expires:     2026-02-14T09:00:00.000Z
#   Cert:        ./gateway-cert.pem
#   Key:         ./gateway-key.pem
```

#### Sign an external CSR

```bash
# When the service generates its own key pair and CSR
catalyst pki cert sign-csr \
  --csr ./service.csr \
  --spiffe-id "spiffe://catalyst.example.com/node/node-c.somebiz.local.io" \
  --ttl-hours 1 \
  --output-cert ./service-cert.pem \
  --auth-url ws://localhost:4020/rpc \
  --token "$ADMIN_TOKEN"
```

#### Export and verify the CA bundle

```bash
# Export the CA bundle
catalyst pki ca bundle --auth-url ws://localhost:4020/rpc --token "$TOKEN" > ca-bundle.pem

# Verify a certificate against the bundle
openssl verify -CAfile ca-bundle.pem service-cert.pem

# Expected output:
# service-cert.pem: OK
```

#### Inspect a certificate

```bash
# View certificate details (subject, issuer, SANs, validity)
openssl x509 -in service-cert.pem -text -noout

# Extract just the SPIFFE ID
openssl x509 -in service-cert.pem -text -noout | grep "URI:"

# Check expiry
openssl x509 -in service-cert.pem -enddate -noout
# notAfter=Feb 13 10:00:00 2026 GMT

# Get the SHA-256 fingerprint (for cnf binding)
openssl x509 -in service-cert.pem -outform DER | openssl dgst -sha256
```

#### Verify a certificate chain manually

```bash
# Full chain verification with intermediate display
openssl verify -show_chain -CAfile ca-bundle.pem service-cert.pem

# Expected output:
# service-cert.pem: OK
# Chain:
# depth=0: CN = gateway-a (untrusted)
# depth=1: CN = Catalyst Services CA
# depth=2: CN = Catalyst Root CA

# Verify with verbose error output (useful for debugging)
openssl verify -verbose -CAfile ca-bundle.pem service-cert.pem
```

#### Emergency deny and recover

```bash
# Deny
catalyst pki identity deny \
  spiffe://catalyst.example.com/orchestrator/compromised-node \
  --reason "Security incident #5678" \
  --auth-url ws://localhost:4020/rpc \
  --token "$ADMIN_TOKEN"

# Check deny list
catalyst pki identity list-denied \
  --auth-url ws://localhost:4020/rpc \
  --token "$ADMIN_TOKEN"

# Re-enable after remediation
catalyst pki identity allow \
  spiffe://catalyst.example.com/orchestrator/compromised-node \
  --auth-url ws://localhost:4020/rpc \
  --token "$ADMIN_TOKEN"
```

---

## 4. Logging and Observability

### 4.1 PKI Events to Log

The PKI system uses the standard Catalyst logging infrastructure (`@catalyst/telemetry`).
All PKI log messages use the `catalyst.pki` category and follow the tagged template
literal format used throughout the codebase.

| Event                             | Level | When                                          |
| :-------------------------------- | :---- | :-------------------------------------------- |
| CA initialized                    | INFO  | Root or intermediate CA created               |
| Certificate issued                | INFO  | CSR signed and certificate stored             |
| Certificate renewal success       | INFO  | Automatic renewal completed                   |
| Certificate renewal attempt       | DEBUG | Each renewal check cycle (every 5 min)        |
| Certificate renewal failed        | WARN  | Renewal attempt failed (CA unreachable, etc.) |
| Certificate renewal critical      | ERROR | < 25% lifetime remaining, renewal failing     |
| Certificate expired               | ERROR | Certificate TTL reached zero                  |
| Identity denied                   | WARN  | SPIFFE ID added to deny list                  |
| Identity allowed                  | INFO  | SPIFFE ID removed from deny list              |
| CSR denied (deny list)            | WARN  | CSR rejected because identity is on deny list |
| CSR validation failed             | WARN  | CSR has invalid format or missing fields      |
| Expired certificates purged       | INFO  | Periodic cleanup of expired cert records      |
| CA certificate approaching expiry | WARN  | Intermediate CA < 6 months from expiry        |

### 4.2 Log Format

**Development (pretty sink):**

```
09:00:01.456 INFO    catalyst.pki: Certificate issued {"fingerprint":"abc123...","spiffe_id":"spiffe://catalyst.example.com/orchestrator/node-a.somebiz.local.io","ttl_seconds":3600,"issuer":"Catalyst Services CA"}
09:30:05.112 INFO    catalyst.pki: Certificate renewed {"old_fingerprint":"abc123...","new_fingerprint":"def456...","spiffe_id":"spiffe://catalyst.example.com/orchestrator/node-a.somebiz.local.io","ttl_seconds":3600}
15:10:33.221 WARN    catalyst.pki: CSR signing denied — identity is on the deny list {"spiffe_id":"spiffe://catalyst.example.com/orchestrator/node-a.somebiz.local.io","reason":"compromised"}
```

**Production (JSON sink):**

```json
{"timestamp":1707818401456,"level":"info","category":"catalyst.pki","message":"Certificate issued","properties":{"fingerprint":"abc123...","spiffe_id":"spiffe://catalyst.example.com/orchestrator/node-a.somebiz.local.io","ttl_seconds":3600,"issuer":"Catalyst Services CA","algorithm":"EC-P384"},"trace_id":"4bf92f...","span_id":"00f067..."}
{"timestamp":1707820205112,"level":"info","category":"catalyst.pki","message":"Certificate renewed","properties":{"old_fingerprint":"abc123...","new_fingerprint":"def456...","spiffe_id":"spiffe://catalyst.example.com/orchestrator/node-a.somebiz.local.io","ttl_seconds":3600},"trace_id":"5cg03h...","span_id":"01g178..."}
{"timestamp":1707836433221,"level":"warn","category":"catalyst.pki","message":"CSR signing denied — identity is on the deny list","properties":{"spiffe_id":"spiffe://catalyst.example.com/orchestrator/node-a.somebiz.local.io","reason":"compromised","denied_at":"2026-02-12T22:00:00.000Z"}}
```

### 4.3 Metrics

The PKI system exposes OpenTelemetry metrics via the standard `ServiceTelemetry.meter`.
These are exported to the OTEL Collector when `OTEL_EXPORTER_OTLP_ENDPOINT` is configured.

| Metric Name                               | Type      | Description                                                                                    |
| :---------------------------------------- | :-------- | :--------------------------------------------------------------------------------------------- |
| `catalyst.pki.cert_issued_total`          | Counter   | Total certificates issued, labeled by `type` (end-entity, intermediate), `algorithm`, `issuer` |
| `catalyst.pki.cert_renewal_success_total` | Counter   | Successful automatic renewals                                                                  |
| `catalyst.pki.cert_renewal_failure_total` | Counter   | Failed renewal attempts, labeled by `error_type` (ca_unreachable, denied, invalid_csr)         |
| `catalyst.pki.cert_expiry_seconds`        | Gauge     | Seconds until the service's current certificate expires. Set per service instance.             |
| `catalyst.pki.ca_expiry_seconds`          | Gauge     | Seconds until each CA certificate expires, labeled by `ca_name`                                |
| `catalyst.pki.deny_list_size`             | Gauge     | Number of identities on the deny list                                                          |
| `catalyst.pki.csr_sign_duration_seconds`  | Histogram | Time to process a CSR signing request                                                          |
| `catalyst.pki.active_cert_count`          | Gauge     | Number of non-expired certificates in the store                                                |
| `catalyst.pki.purged_cert_count`          | Counter   | Number of expired certificates cleaned up                                                      |

### 4.4 Alerts

Configure these alerts in your monitoring system (Prometheus Alertmanager,
Grafana, Datadog, etc.):

**Critical:**

| Alert                             | Condition                                               | Action                                                   |
| :-------------------------------- | :------------------------------------------------------ | :------------------------------------------------------- |
| Certificate renewal failing       | `cert_renewal_failure_total` increases for > 15 minutes | Check CA availability, review auth service logs          |
| Certificate expired               | `cert_expiry_seconds` <= 0                              | Restart affected service, investigate why renewal failed |
| CA certificate approaching expiry | `ca_expiry_seconds` < 30 days (for intermediate)        | Schedule intermediate CA rotation                        |

**Warning:**

| Alert                  | Condition                            | Action                                                  |
| :--------------------- | :----------------------------------- | :------------------------------------------------------ |
| Certificate expiry low | `cert_expiry_seconds` < 900 (15 min) | Check renewal loop, verify CA connectivity              |
| Deny list growing      | `deny_list_size` > 10                | Review denied identities, may indicate ongoing incident |
| CSR signing slow       | `csr_sign_duration_seconds` p99 > 5s | Check CA performance, backend latency                   |

**Example Prometheus alert rules:**

```yaml
groups:
  - name: catalyst-pki
    rules:
      - alert: CertRenewalFailing
        expr: increase(catalyst_pki_cert_renewal_failure_total[15m]) > 3
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: 'PKI certificate renewal is failing'
          description: '{{ $labels.instance }} has had {{ $value }} renewal failures in 15 minutes'

      - alert: CertExpiringSoon
        expr: catalyst_pki_cert_expiry_seconds < 900
        for: 0m
        labels:
          severity: warning
        annotations:
          summary: 'Service certificate expiring within 15 minutes'
          description: '{{ $labels.instance }} certificate expires in {{ $value }}s'

      - alert: CACertExpiring
        expr: catalyst_pki_ca_expiry_seconds < 2592000 # 30 days
        for: 0m
        labels:
          severity: warning
        annotations:
          summary: 'CA certificate expiring within 30 days'
          description: '{{ $labels.ca_name }} expires in {{ $value | humanizeDuration }}'
```

---

## 5. Environment-Specific Guidance

### 5.1 Local Development

**Goal:** Zero-configuration PKI that just works for `bun run`.

**Defaults applied automatically:**

- Ephemeral CA auto-generated on first boot (stored in local `certs.db`)
- SVID TTL: 24 hours (so you do not need to worry about renewal during a coding session)
- Trust domain: `catalyst.example.com`
- CA key stored in SQLite (not HSM)

**No PKI environment variables are required.** The auth service handles
everything automatically. You only need the standard variables:

```bash
export CATALYST_NODE_ID="dev-node"
export CATALYST_DOMAINS="dev.local"
export CATALYST_PEERING_ENDPOINT="ws://localhost:3000/rpc"
```

**Testing with ephemeral PKI:**
The `PKIManager` supports an in-memory mode (`:memory:` SQLite), mirroring
the existing `JWTTokenFactory.ephemeral()` pattern:

```typescript
import { PKIManager, BunSqliteCertificateStore } from '@catalyst/pki'

// Ephemeral PKI for tests — no files on disk
const store = new BunSqliteCertificateStore(':memory:')
const pki = new PKIManager(store, signingBackend)
await pki.initialize()

// Generate a test certificate
const result = await pki.signCSR({ ... })
```

---

### 5.2 Docker Compose

**Key considerations:**

- CA data must persist across container restarts
- Bootstrap tokens must be available before services start
- The CA bundle must be accessible to all services

**Volume mounts:**

```yaml
services:
  auth:
    volumes:
      - auth-pki-data:/data/pki # Persists CA keys + certificates
    environment:
      - CATALYST_PKI_CERTS_DB=/data/pki/certs.db
      - CATALYST_PKI_TRUST_DOMAIN=somebiz.local.io
      - CATALYST_PKI_SVID_TTL=3600

  orchestrator:
    environment:
      - CATALYST_AUTH_URL=ws://auth:4020/rpc
      - CATALYST_BOOTSTRAP_TOKEN=${CATALYST_BOOTSTRAP_TOKEN}
    depends_on:
      auth:
        condition: service_healthy

volumes:
  auth-pki-data:
```

**Bootstrap sequence:**

1. `auth` starts first, generates CA, mints system token
2. System token is extracted from logs or pre-configured via `CATALYST_SYSTEM_TOKEN`
3. Orchestrator starts with the bootstrap token, obtains its certificate via CSR
4. Gateway and other services follow the same pattern

**Getting the bootstrap token in compose:**

Option A: Pre-shared (for development compose files):

```yaml
auth:
  environment:
    - CATALYST_BOOTSTRAP_TOKEN=dev-bootstrap-token
orchestrator:
  environment:
    - CATALYST_BOOTSTRAP_TOKEN=dev-bootstrap-token
```

Option B: Extract from auth logs (for production-like compose):

```bash
# Start auth first
docker compose up -d auth

# Wait for health check
docker compose exec auth curl -sf http://localhost:4020/health

# Extract system token from logs
export CATALYST_SYSTEM_TOKEN=$(docker compose logs auth 2>&1 | grep "System Admin Token" | awk '{print $NF}')

# Mint a bootstrap token
export CATALYST_BOOTSTRAP_TOKEN=$(docker compose exec auth \
  catalyst auth token mint bootstrap --principal ADMIN --expires-in 1h)

# Start remaining services
docker compose up -d
```

---

### 5.3 Production

**CA Key Security:**

- Use cloud KMS for CA signing keys (AWS KMS or GCP Cloud KMS)
- Configure via environment variable:
  ```bash
  CATALYST_PKI_KEY_BACKEND=aws-kms
  CATALYST_PKI_KMS_KEY_ARN=arn:aws:kms:us-east-1:123456789:key/abc-def-ghi
  ```
- The SQLite database (`certs.db`) only stores certificate metadata and
  public material when KMS is used. Private keys never leave the HSM.

**Short SVID TTL:**

```bash
CATALYST_PKI_SVID_TTL=3600        # 1 hour (default, recommended)
```

Do not exceed 24 hours. Shorter TTLs reduce the blast radius of key compromise.

**High Availability:**

- Run multiple auth service replicas behind a load balancer
- All replicas share the same CA database (or use cloud KMS for signing)
- Certificate renewal from any service can hit any auth replica

**Monitoring checklist:**

- [ ] `OTEL_EXPORTER_OTLP_ENDPOINT` configured for metrics/logs export
- [ ] Prometheus alert rules deployed (see [Section 4.4](#44-alerts))
- [ ] Dashboard showing `cert_expiry_seconds` per service
- [ ] Dashboard showing `ca_expiry_seconds` for each intermediate CA
- [ ] PagerDuty / OpsGenie integration for critical cert alerts

**Network security:**

- The PKI HTTP endpoints (`/pki/ca/bundle`, `/pki/crl`) are intentionally
  public (read-only trust anchor distribution)
- All write endpoints (`/pki/keypair`, `/pki/csr/sign`, `/pki/intermediary`)
  require admin authentication and are gated by Cedar policies
- The auth service RPC endpoint (`/rpc`) should be restricted to internal
  networks (not exposed to the public internet)

**Backup schedule:**

- Daily: SQLite database backup (certificate metadata)
- KMS keys: managed by cloud provider (automatic replication and backup)
- Root CA: if using local keys, encrypt and store offline in multiple
  geographic locations

---

## Appendix: Environment Variables Reference

| Variable                    | Description                                           | Default                |
| :-------------------------- | :---------------------------------------------------- | :--------------------- |
| `CATALYST_PKI_TRUST_DOMAIN` | SPIFFE trust domain                                   | `catalyst.example.com` |
| `CATALYST_PKI_SVID_TTL`     | End-entity certificate lifetime in seconds            | `3600` (1 hour)        |
| `CATALYST_PKI_CERTS_DB`     | Path to certificate store SQLite database             | `certs.db`             |
| `CATALYST_PKI_AUTO_RENEW`   | Enable automatic certificate renewal                  | `true`                 |
| `CATALYST_PKI_KEY_BACKEND`  | Key storage backend (`local`, `aws-kms`, `gcp-kms`)   | `local`                |
| `CATALYST_PKI_KMS_KEY_ARN`  | AWS KMS key ARN (when backend is `aws-kms`)           | -                      |
| `CATALYST_PKI_KMS_KEY_NAME` | GCP KMS key resource name (when backend is `gcp-kms`) | -                      |
| `CATALYST_PEER_AUTH_MODE`   | Peering auth mode (`secret`, `mtls`, `both`)          | `secret`               |
| `CATALYST_BOOTSTRAP_TOKEN`  | Bootstrap token for initial CSR authentication        | -                      |
| `CATALYST_BOOTSTRAP_TTL`    | Bootstrap token TTL in milliseconds                   | `86400000` (24h)       |
