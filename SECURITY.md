# Catalyst Node Peer Security Protocol

## Overview

Peering security uses a Defense-in-Depth approach, layering Transport Security (mTLS) with Application-Layer Authentication (PSK/JWKS) during the **Open Negotiation** phase.

## 1. Transport Security (mTLS)

**Requirement**: Mandatory for all connections.
- All BGP sessions MUST run over TLS 1.3.
- Mutual Authentication (mTLS) is required: both client and server must present valid certificates signed by a trusted CA (e.g., the internal PKI of the AS).
- The Common Name (CN) or SAN in the certificate must match the `BGP Identifier` (Node ID).

## 2. Peering Authentication

Verified during the exchange of the `OPEN` message.

### Pre-Shared Key (PSK)
- **Field**: `psk` (optional) in `OPEN` message.
- **Usage**: Contains the Key ID.
- **Verification**: The receiver looks up the shared secret associated with the Key ID. The message framing (or TLS exporter) is verified using this secret to ensure the peer possesses it.

### JSON Web Key Set (JWKS)
- **Field**: `jwks` (optional) in `OPEN` message.
- **Usage**: Contains the public keys (`{ keys: [...] }`) of the sending AS.
- **Verification**:
    - Allows the receiver to dynamically learn the peer's public keys.
    - Subsequent messages (or the OPEN message itself via a detached signature) can be verified against these keys.
    - Useful for **External Peerings** (eBGP) where a shared PKI might not exist.

## Open Negotiation Flow

1.  **Transport Connection**: TCP -> TLS Handshake (mTLS).
    - If certs are invalid, connection is dropped immediately.

2.  **Initiator** sends `OPEN`:
    ```json
    {
      "type": "OPEN",
      "version": 1,
      "myAsn": 65001,
      "bgpIdentifier": "node-01.dc01",
      "holdTime": 180,
      "psk": "key-id-123",
      "jwks": { "keys": [...] }
    }
    ```

3.  **Receiver** validates:
    - **mTLS Identity**: Check certificate CN matches `bgpIdentifier`.
    - **PSK/JWKS**: If provided, validate Key ID or import Keys.
    - **Policy**: Check if ASN 65001 is a permitted peer.

4.  **Receiver** responds with `OPEN`:
    - Session enters `ESTABLISHED` state.
    - `KEEPALIVE` messages begin.
