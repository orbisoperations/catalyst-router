# Bun TLS/mTLS Cookbook

Practical code examples for using TLS and mTLS with Bun. Covers configuring
`Bun.serve()` as a TLS/mTLS server and using `fetch()` with client certificates
for mTLS client connections.

For background on PKI concepts, see the [PKI Primer](pki-primer.md). For
Catalyst's specific certificate hierarchy, see
[ADR 0011](../adr/0011-pki-hierarchy-and-certificate-profiles.md).

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [TLS Server (One-Way TLS)](#2-tls-server-one-way-tls)
3. [mTLS Server (Mutual TLS)](#3-mtls-server-mutual-tls)
4. [mTLS Client with fetch()](#4-mtls-client-with-fetch)
5. [Loading Certificates from the PKI Package](#5-loading-certificates-from-the-pki-package)
6. [Hot-Swapping Certificates](#6-hot-swapping-certificates)
7. [Common Errors and Fixes](#7-common-errors-and-fixes)

---

## 1. Prerequisites

You need three PEM files for a minimal TLS setup:

| File            | Contents                       | Who holds it      |
| :-------------- | :----------------------------- | :---------------- |
| `cert.pem`      | Server's certificate (+ chain) | Server            |
| `key.pem`       | Server's private key           | Server (secret)   |
| `ca-bundle.pem` | Trusted CA certificates        | Both sides (mTLS) |

For mTLS, the client also needs its own `client-cert.pem` and `client-key.pem`.

---

## 2. TLS Server (One-Way TLS)

A basic HTTPS server where only the server presents a certificate. Clients
verify the server but the server does not verify clients.

```typescript
const server = Bun.serve({
  port: 4443,
  tls: {
    cert: Bun.file('/path/to/cert.pem'),
    key: Bun.file('/path/to/key.pem'),
  },
  fetch(req) {
    return new Response('Hello over TLS')
  },
})

console.log(`TLS server listening on https://localhost:${server.port}`)
```

**Certificate chain:** If your certificate was signed by an intermediate CA
(as in Catalyst), the `cert` file should contain the full chain -- your leaf
certificate followed by the intermediate CA certificate:

```
-----BEGIN CERTIFICATE-----
(your leaf certificate)
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
(intermediate CA certificate)
-----END CERTIFICATE-----
```

You can concatenate them:

```bash
cat leaf-cert.pem intermediate-ca.pem > cert-chain.pem
```

Or pass them as an array:

```typescript
tls: {
  cert: [
    Bun.file('/path/to/leaf-cert.pem'),
    Bun.file('/path/to/intermediate-ca.pem'),
  ],
  key: Bun.file('/path/to/key.pem'),
},
```

---

## 3. mTLS Server (Mutual TLS)

An mTLS server requires clients to present a valid certificate. Add the `ca`
option (the CA certificates you trust for client verification) and set
`requestCert` and `rejectUnauthorized`:

```typescript
const server = Bun.serve({
  port: 4443,
  tls: {
    cert: Bun.file('/path/to/server-cert.pem'),
    key: Bun.file('/path/to/server-key.pem'),

    // Trust anchor for verifying client certificates
    ca: Bun.file('/path/to/ca-bundle.pem'),

    // Require clients to present a certificate
    requestCert: true,

    // Reject connections where the client cert fails verification
    rejectUnauthorized: true,
  },
  fetch(req, server) {
    return new Response('Mutual TLS established')
  },
})
```

**`ca`:** One or more CA certificates that the server uses to verify client
certificates. In Catalyst, this would be the Services CA + Root CA bundle
(for service-to-service mTLS) or the Transport CA + Root CA bundle (for
Envoy mTLS).

**`requestCert: true`:** The server sends a `CertificateRequest` message
during the TLS handshake, asking the client to present a certificate.

**`rejectUnauthorized: true`:** Connections where the client certificate
fails chain validation are rejected at the TLS layer.

---

## 4. mTLS Client with fetch()

To connect to an mTLS server, the client must present its own certificate.
Pass TLS options to `fetch()`:

```typescript
const response = await fetch('https://peer-node:4443/api/status', {
  tls: {
    // Client certificate and private key
    cert: Bun.file('/path/to/client-cert.pem'),
    key: Bun.file('/path/to/client-key.pem'),

    // Trust anchor for verifying the server's certificate
    ca: Bun.file('/path/to/ca-bundle.pem'),
  },
})

const data = await response.json()
console.log('Response:', data)
```

**When to use client certificates with fetch:**

- Connecting to another Catalyst service that requires mTLS
  (orchestrator-to-orchestrator peering)
- Submitting a CSR to the auth service for certificate renewal
  (the current certificate authenticates the renewal request)
- Any cross-service call where the server enforces `requestCert: true`

**Self-signed or private CA:** If the server uses a certificate signed by a
private CA (like Catalyst's Root CA), you must provide the `ca` option. Without
it, `fetch()` will reject the server's certificate as untrusted:

```
error: unable to verify the first certificate
```

---

## 5. Loading Certificates from the PKI Package

In Catalyst services, certificates are obtained programmatically from the
`CertificateManager`. Here is how to combine PKI-issued certificates with
Bun's TLS configuration:

```typescript
import { CertificateManager } from '@catalyst/pki'

// Assume the CertificateManager is initialized and has signed a CSR
const signResult = await manager.signCSR({
  csrPem,
  serviceType: 'orchestrator',
  instanceId: 'node-a.example.com',
})

// signResult contains:
//   certificatePem:  the leaf certificate (PEM string)
//   chain:           [intermediate CA PEM, root CA PEM]
//   expiresAt:       ISO timestamp
//   renewAfter:      ISO timestamp (50% of lifetime)

// Build the full cert chain for Bun.serve()
const fullChain = signResult.certificatePem + '\n' + signResult.chain[0]

// Get the CA bundle for verifying peers
const bundle = await manager.getCaBundle()
const caBundlePem = bundle.servicesBundle.join('\n')

// Configure the server
const server = Bun.serve({
  port: 3000,
  tls: {
    cert: fullChain,
    key: privateKeyPem, // the private key from the CSR key pair
    ca: caBundlePem,
    requestCert: true,
    rejectUnauthorized: true,
  },
  fetch(req) {
    return new Response('mTLS OK')
  },
})
```

Note: The private key (`privateKeyPem`) is the key that was generated locally
when creating the CSR. It is never sent to the CA -- only the public key
travels in the CSR.

---

## 6. Hot-Swapping Certificates

When a certificate is renewed (every 30 minutes by default), the service
needs to load the new certificate without dropping connections. Bun supports
reloading TLS configuration on a running server:

```typescript
// After obtaining a renewed certificate
const newSignResult = await manager.signCSR({
  /* ... */
})
const newChain = newSignResult.certificatePem + '\n' + newSignResult.chain[0]

// Reload TLS on the running server
server.reload({
  tls: {
    cert: newChain,
    key: newPrivateKeyPem,
    ca: caBundlePem,
    requestCert: true,
    rejectUnauthorized: true,
  },
})

// Existing connections continue on the old cert until they close.
// New connections use the new cert.
```

`server.reload()` is non-disruptive: in-flight requests complete on the old
TLS context, and new connections use the updated certificates.

---

## 7. Common Errors and Fixes

### `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`

**Cause:** The certificate chain is incomplete. The verifier cannot find the
intermediate CA certificate.

**Fix:** Ensure the `cert` option includes the full chain (leaf + intermediate),
or that the `ca` option includes the intermediate CA.

### `DEPTH_ZERO_SELF_SIGNED_CERT`

**Cause:** The server's certificate is self-signed and the client does not
trust it.

**Fix:** Add the CA certificate to the `ca` option in the client's `fetch()` call
or `Bun.serve()` config.

### `unable to verify the first certificate`

**Cause:** The `ca` trust bundle does not include the CA that signed the
server's certificate.

**Fix:** Add the correct CA bundle. For Catalyst services, use the
`servicesBundle` from `CertificateManager.getCaBundle()`.

### `ECONNRESET` during TLS handshake

**Cause:** The server requires a client certificate (`requestCert: true`) but
the client did not provide one.

**Fix:** Add `tls.cert` and `tls.key` to the `fetch()` call.

### `certificate has expired`

**Cause:** The certificate's `notAfter` time has passed.

**Fix:** Check that certificate renewal is running. For Catalyst services,
verify the auth service is reachable and the renewal timer is active. See
the [Operations Guide](operations-guide.md) Section 1.1.

### Certificate works in curl but not in Bun

**Cause:** Bun may not trust the system certificate store by default for
custom CAs.

**Fix:** Explicitly provide the CA bundle via the `ca` option rather than
relying on system trust stores. This is the recommended approach for
Catalyst services.
