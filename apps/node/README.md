# @catalyst/node-service

The **Catalyst Composite Node** runs Auth, Orchestrator, and Gateway as a single process. Instead of deploying three separate containers, you get one binary that mounts all services on sub-paths and wires them together automatically.

## Quick Start

```bash
bun run dev -- --node-id my-node.somebiz.local.io
```

This starts a composite node on port 3000 with all services ready. The peering endpoint is auto-derived.

## Mount Paths

All three services are mounted under their own sub-path on a single HTTP server:

| Path              | Service      | Description                                   |
| :---------------- | :----------- | :-------------------------------------------- |
| `/auth/*`         | Auth         | JWKS endpoints and token RPC                  |
| `/orchestrator/*` | Orchestrator | Peer and route management RPC                 |
| `/gateway/*`      | Gateway      | GraphQL federation and config RPC             |
| `/`               | Node         | JSON info endpoint (node ID, version, mounts) |
| `/health`         | Node         | Health check                                  |

Services initialize in order: Auth -> Gateway -> Orchestrator. Auth and Gateway have no network dependencies on startup, so they initialize first. Orchestrator then connects to Auth via loopback for token operations.

## CLI Reference

All options can be set via CLI flags, environment variables, or a JSON config file. Precedence: CLI flags > environment variables > config file > defaults.

| Flag                        | Env Var                             | Required | Default         | Description                                                  |
| :-------------------------- | :---------------------------------- | :------- | :-------------- | :----------------------------------------------------------- |
| `--config <path>`           | `CATALYST_NODE_CONFIG`              | No       |                 | Path to JSON config file                                     |
| `--node-id <id>`            | `CATALYST_NODE_ID`                  | Yes      |                 | Node identifier (must match `*.somebiz.local.io`)            |
| `--peering-endpoint <url>`  | `CATALYST_PEERING_ENDPOINT`         | No       | Auto-derived    | WebSocket endpoint for iBGP peering (auto-derived from port) |
| `--port <port>`             | `PORT`                              | No       | `3000`          | Port to listen on                                            |
| `--hostname <host>`         |                                     | No       | `0.0.0.0`       | Hostname to bind to                                          |
| `--domains <domains>`       | `CATALYST_DOMAINS`                  | No       |                 | Comma-separated list of trusted domains                      |
| `--peering-secret <secret>` | `CATALYST_PEERING_SECRET`           | No       | `valid-secret`  | iBGP peering secret                                          |
| `--keys-db <path>`          | `CATALYST_AUTH_KEYS_DB`             | No       | `keys.db`       | SQLite database path for auth keys                           |
| `--tokens-db <path>`        | `CATALYST_AUTH_TOKENS_DB`           | No       | `tokens.db`     | SQLite database path for auth tokens                         |
| `--revocation`              | `CATALYST_AUTH_REVOCATION`          | No       | `true`          | Enable token revocation                                      |
| `--revocation-max-size <n>` | `CATALYST_AUTH_REVOCATION_MAX_SIZE` | No       |                 | Max revocation list size                                     |
| `--bootstrap-token <token>` | `CATALYST_BOOTSTRAP_TOKEN`          | No       |                 | Bootstrap authentication token                               |
| `--bootstrap-ttl <ms>`      | `CATALYST_BOOTSTRAP_TTL`            | No       |                 | Bootstrap token TTL in milliseconds                          |
| `--gateway-endpoint <url>`  | `CATALYST_GQL_GATEWAY_ENDPOINT`     | No       | Auto-configured | Override gateway RPC endpoint for route sync                 |
| `--log-level <level>`       |                                     | No       | `info`          | Log level                                                    |

## In-Process vs Separate Deployment

In composite mode, several things are handled differently from running services as separate containers:

| Concern               | Composite Mode                                            | Separate Deployment                                 |
| :-------------------- | :-------------------------------------------------------- | :-------------------------------------------------- |
| **Auth**              | Runs in-process; orchestrator skips network token minting | Auth is a separate container; tokens minted via RPC |
| **Gateway RPC**       | Auto-wired to `ws://localhost:<port>/gateway/api`         | Must configure `CATALYST_GQL_GATEWAY_ENDPOINT`      |
| **WebSocket handler** | Shared across all services via `hono/bun`                 | Each service has its own WebSocket listener         |
| **Startup order**     | Guaranteed: Auth -> Gateway -> Orchestrator               | Must be orchestrated externally (compose/k8s)       |
| **Scaling**           | Single process, single node                               | Each service scales independently                   |

## Build & Run

Requires [Bun](https://bun.sh) runtime.

```bash
# Run from source (development)
bun run dev -- --node-id my-node.somebiz.local.io

# Build with tsup (ESM-only output)
bun run build

# Run the built output
bun run start -- --node-id my-node.somebiz.local.io
```

## Environment Variable Quick Start

For environments where CLI flags are not practical (containers, systemd), set environment variables instead:

```bash
export CATALYST_NODE_ID="my-node.somebiz.local.io"
export PORT=3000

bun run start
```

## Config File

The Catalyst Node supports configuration via a JSON config file, specified with the `--config` flag or the `CATALYST_NODE_CONFIG` environment variable.

**Precedence:** CLI flags > environment variables > config file > defaults.

This means you can set defaults in a config file and override specific values with environment variables or CLI flags.

### Example Config

```json
{
  "nodeId": "my-node.somebiz.local.io",
  "domains": ["somebiz.local.io"],
  "keysDb": "./data/keys.db",
  "tokensDb": "./data/tokens.db"
}
```

### Config File Fields

All fields are optional unless specified.

| Field               | Type       | Description                                                        |
| :------------------ | :--------- | :----------------------------------------------------------------- |
| `nodeId`            | `string`   | Node identifier (must match `*.somebiz.local.io`)                  |
| `peeringEndpoint`   | `string`   | WebSocket endpoint for iBGP peering (auto-derived if not provided) |
| `port`              | `number`   | Port to listen on (default: 3000)                                  |
| `hostname`          | `string`   | Hostname to bind to (default: 0.0.0.0)                             |
| `domains`           | `string[]` | Array of trusted domains (vs comma-separated string on CLI)        |
| `peeringSecret`     | `string`   | iBGP peering secret (default: valid-secret)                        |
| `keysDb`            | `string`   | SQLite database path for auth keys (default: keys.db)              |
| `tokensDb`          | `string`   | SQLite database path for auth tokens (default: tokens.db)          |
| `revocation`        | `boolean`  | Enable token revocation (default: true)                            |
| `revocationMaxSize` | `number`   | Max revocation list size                                           |
| `bootstrapToken`    | `string`   | Bootstrap authentication token                                     |
| `bootstrapTtl`      | `number`   | Bootstrap token TTL in milliseconds                                |
| `gatewayEndpoint`   | `string`   | Override gateway RPC endpoint for route sync (auto-configured)     |
| `logLevel`          | `string`   | Log level (default: info)                                          |

**Note:** Unknown keys are rejected (strict validation).

## CLI Usage Examples

### Minimal Startup

Since `--peering-endpoint` is now auto-derived in composite mode, you only need to specify `--node-id`:

```bash
bun run start -- --node-id my-node.somebiz.local.io
```

### Custom Port and Hostname

```bash
bun run start -- \
  --node-id my-node.somebiz.local.io \
  --port 8080 \
  --hostname 127.0.0.1
```

### With Trusted Domains

```bash
bun run start -- \
  --node-id my-node.somebiz.local.io \
  --domains somebiz.local.io,another.local.io
```

### Custom Database Paths

```bash
bun run start -- \
  --node-id my-node.somebiz.local.io \
  --keys-db /data/keys.db \
  --tokens-db /data/tokens.db
```

### Disable Token Revocation

Since revocation is now enabled by default, use `--no-revocation` to disable it:

```bash
bun run start -- \
  --node-id my-node.somebiz.local.io \
  --no-revocation
```

### Enable Revocation with Max Size

```bash
bun run start -- \
  --node-id my-node.somebiz.local.io \
  --revocation \
  --revocation-max-size 10000
```

### Bootstrap Token for Initial Setup

```bash
bun run start -- \
  --node-id my-node.somebiz.local.io \
  --bootstrap-token my-secure-token \
  --bootstrap-ttl 3600000
```

### Custom Peering Secret

```bash
bun run start -- \
  --node-id my-node.somebiz.local.io \
  --peering-secret my-super-secret-key
```

### Override Gateway Endpoint

```bash
bun run start -- \
  --node-id my-node.somebiz.local.io \
  --gateway-endpoint ws://custom-gateway:4000/gateway/api
```

### Explicit Peering Endpoint

Override the auto-derived peering endpoint:

```bash
bun run start -- \
  --node-id my-node.somebiz.local.io \
  --peering-endpoint ws://external-orchestrator:3000/orchestrator/rpc
```

### Verbose Logging

```bash
bun run start -- \
  --node-id my-node.somebiz.local.io \
  --log-level debug
```

### Using a Config File

```bash
bun run start -- --config /path/to/catalyst-node.config.json
```

### Config File with CLI Overrides

CLI flags take precedence over config file values:

```bash
bun run start -- \
  --config /path/to/catalyst-node.config.json \
  --port 8080 \
  --log-level debug
```

### Config File via Environment Variable

```bash
export CATALYST_NODE_CONFIG=/path/to/catalyst-node.config.json
bun run start
```

### Full Environment Variable Configuration

```bash
export CATALYST_NODE_ID="my-node.somebiz.local.io"
export CATALYST_PEERING_ENDPOINT="ws://localhost:3000/orchestrator/rpc"
export PORT=3000
export CATALYST_DOMAINS="somebiz.local.io,another.local.io"
export CATALYST_PEERING_SECRET="my-super-secret-key"
export CATALYST_AUTH_KEYS_DB="/data/keys.db"
export CATALYST_AUTH_TOKENS_DB="/data/tokens.db"
export CATALYST_AUTH_REVOCATION="true"
export CATALYST_AUTH_REVOCATION_MAX_SIZE="10000"
export CATALYST_BOOTSTRAP_TOKEN="my-secure-token"
export CATALYST_BOOTSTRAP_TTL="3600000"
export CATALYST_GQL_GATEWAY_ENDPOINT="ws://custom-gateway:4000/gateway/api"

bun run start
```
