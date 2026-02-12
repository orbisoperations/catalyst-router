# Catalyst Router CLI

The `catalyst` CLI provides a hierarchical command interface for managing Catalyst Router nodes. Built with [Commander.js](https://github.com/tj/commander.js), it communicates with the orchestrator and auth services via Capnweb RPC over WebSocket.

## Global Options

These options apply to all commands:

```
--orchestrator-url <url>   Orchestrator RPC URL (env: CATALYST_ORCHESTRATOR_URL, default: ws://localhost:3000/rpc)
--auth-url <url>           Auth service RPC URL (env: CATALYST_AUTH_URL, default: ws://localhost:4000/rpc)
--token <token>            Auth token (env: CATALYST_AUTH_TOKEN)
--log-level <level>        Log level (default: info)
--version                  Show version
```

## Command Structure

```
catalyst
  node                     Node management
    peer                   Manage peer connections
      create               Create a new peer
      list                 List all peers
      delete               Delete a peer
    route                  Manage local routes
      create               Create a new route
      list                 List all routes
      delete               Delete a route
  auth                     Authentication management
    token                  Token lifecycle
      mint                 Mint a new token
      verify               Verify a token
      revoke               Revoke a token
      list                 List tokens
  graphql                  GraphQL gateway management
```

---

## Node Commands

### Peer Management

#### `catalyst node peer create`

Create a new peer connection.

```bash
catalyst node peer create <name> <endpoint> [options]
```

| Argument/Option        | Description                                       |
| ---------------------- | ------------------------------------------------- |
| `<name>`               | Peer name (FQDN)                                  |
| `<endpoint>`           | WebSocket endpoint (e.g., `ws://peer-b:3000/rpc`) |
| `--domains <domains>`  | Comma-separated list of domains                   |
| `--peer-token <token>` | Token for authenticating with the peer            |
| `--token <token>`      | Auth token for this operation                     |

**Example:**

```bash
catalyst node peer create peer-b.example.com ws://10.0.0.5:3000/rpc \
  --domains "services.example.com,api.example.com" \
  --peer-token eyJhbG...
```

#### `catalyst node peer list`

List all peers and their connection status.

```bash
catalyst node peer list [options]
```

| Option            | Description |
| ----------------- | ----------- |
| `--token <token>` | Auth token  |

#### `catalyst node peer delete`

Delete a peer connection.

```bash
catalyst node peer delete <name> [options]
```

| Argument/Option   | Description         |
| ----------------- | ------------------- |
| `<name>`          | Peer name to delete |
| `--token <token>` | Auth token          |

---

### Route Management

#### `catalyst node route create`

Create a new local route (advertise a service).

```bash
catalyst node route create <name> <endpoint> [options]
```

| Argument/Option             | Description                                                                         |
| --------------------------- | ----------------------------------------------------------------------------------- |
| `<name>`                    | Route name                                                                          |
| `<endpoint>`                | Service endpoint URL                                                                |
| `-p, --protocol <protocol>` | Protocol: `http`, `http:graphql`, `http:gql`, `http:grpc` (default: `http:graphql`) |
| `--region <region>`         | Region tag                                                                          |
| `--tags <tags>`             | Comma-separated tags                                                                |
| `--token <token>`           | Auth token                                                                          |

**Example:**

```bash
catalyst node route create books-api http://localhost:4001/graphql \
  --protocol http:graphql \
  --region us-east-1 \
  --tags "production,v2"
```

#### `catalyst node route list`

List all routes (local and internal).

```bash
catalyst node route list [options]
```

| Option            | Description |
| ----------------- | ----------- |
| `--token <token>` | Auth token  |

#### `catalyst node route delete`

Delete a local route.

```bash
catalyst node route delete <name> [options]
```

| Argument/Option   | Description          |
| ----------------- | -------------------- |
| `<name>`          | Route name to delete |
| `--token <token>` | Auth token           |

---

## Auth Commands

### Token Management

#### `catalyst auth token mint`

Mint a new JWT token. Requires `ADMIN` principal.

```bash
catalyst auth token mint <subject> [options]
```

| Argument/Option               | Description                                                                   |
| ----------------------------- | ----------------------------------------------------------------------------- |
| `<subject>`                   | Token subject (user/service ID)                                               |
| `--principal <principal>`     | `ADMIN`, `NODE`, `NODE_CUSTODIAN`, `DATA_CUSTODIAN`, `USER` (default: `USER`) |
| `--name <name>`               | Entity name (defaults to subject)                                             |
| `--type <type>`               | Entity type: `user`, `service` (default: `user`)                              |
| `--expires-in <duration>`     | Expiration duration (e.g., `1h`, `7d`, `30m`)                                 |
| `--node-id <nodeId>`          | Node ID (required for `NODE` principal)                                       |
| `--trusted-domains <domains>` | Comma-separated trusted domains                                               |
| `--trusted-nodes <nodes>`     | Comma-separated trusted nodes                                                 |
| `--token <token>`             | Admin auth token                                                              |

**Example:**

```bash
catalyst auth token mint node-b \
  --principal NODE \
  --type service \
  --node-id node-b.dc01 \
  --trusted-domains "services.example.com" \
  --expires-in 7d \
  --token $ADMIN_TOKEN
```

#### `catalyst auth token verify`

Verify a JWT token.

```bash
catalyst auth token verify <token-to-verify> [options]
```

| Argument/Option         | Description             |
| ----------------------- | ----------------------- |
| `<token-to-verify>`     | The JWT token to verify |
| `--audience <audience>` | Expected audience       |
| `--token <token>`       | Auth token              |

#### `catalyst auth token revoke`

Revoke a token by JTI or SAN.

```bash
catalyst auth token revoke [options]
```

| Option            | Description                         |
| ----------------- | ----------------------------------- |
| `--jti <jti>`     | Token JTI to revoke                 |
| `--san <san>`     | Revoke all tokens matching this SAN |
| `--token <token>` | Admin auth token                    |

#### `catalyst auth token list`

List tokens with optional filters.

```bash
catalyst auth token list [options]
```

| Option                             | Description                       |
| ---------------------------------- | --------------------------------- |
| `--cert-fingerprint <fingerprint>` | Filter by certificate fingerprint |
| `--san <san>`                      | Filter by SAN                     |
| `--token <token>`                  | Admin auth token                  |

---

## Environment Variables

The CLI reads these environment variables as defaults:

| Variable                    | Maps to              |
| --------------------------- | -------------------- |
| `CATALYST_ORCHESTRATOR_URL` | `--orchestrator-url` |
| `CATALYST_AUTH_URL`         | `--auth-url`         |
| `CATALYST_AUTH_TOKEN`       | `--token`            |

---

## Examples

### Set up a two-node peering topology

```bash
# On Node A: mint a peer token for Node B
export ADMIN_TOKEN=$(catalyst auth token mint system --principal ADMIN --token $BOOTSTRAP_TOKEN)

NODE_B_TOKEN=$(catalyst auth token mint node-b \
  --principal NODE \
  --type service \
  --node-id node-b \
  --token $ADMIN_TOKEN)

# On Node A: add Node B as a peer
catalyst node peer create node-b ws://node-b:3000/rpc \
  --domains "services.b.example.com" \
  --peer-token $NODE_B_TOKEN

# Register a local service
catalyst node route create books-api http://localhost:4001/graphql \
  --protocol http:graphql

# Verify routes are propagating
catalyst node route list
catalyst node peer list
```
