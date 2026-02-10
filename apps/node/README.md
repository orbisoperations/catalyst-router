# @catalyst/node-service

The **Catalyst Composite Node** runs Auth, Orchestrator, and Gateway as a single process. Instead of deploying three separate containers, you get one binary that mounts all services on sub-paths and wires them together automatically.

## Quick Start

```bash
bun run dev -- \
  --node-id my-node.example.local.io \
  --peering-endpoint ws://localhost:3000/orchestrator/rpc
```

This starts a composite node on port 3000 with all services ready.

## Mount Paths

All three services are mounted under their own sub-path on a single HTTP server:

| Path              | Service      | Description                                   |
| :---------------- | :----------- | :-------------------------------------------- |
| `/auth/*`         | Auth         | JWKS endpoints and token RPC                  |
| `/orchestrator/*` | Orchestrator | Peer and route management RPC                 |
| `/gateway/*`      | Gateway      | GraphQL federation and config RPC             |
| `/`               | Node         | JSON info endpoint (node ID, version, mounts) |
| `/health`         | Node         | Health check                                  |

Services initialize in order: Auth -> Orchestrator -> Gateway. This ensures token infrastructure is available before the orchestrator starts, and routes are available before the gateway starts.

## CLI Reference

All options can be set via CLI flags or environment variables. CLI flags take precedence.

| Flag                        | Env Var                             | Required | Default         | Description                                       |
| :-------------------------- | :---------------------------------- | :------- | :-------------- | :------------------------------------------------ |
| `--node-id <id>`            | `CATALYST_NODE_ID`                  | Yes      |                 | Node identifier (must match `*.somebiz.local.io`) |
| `--peering-endpoint <url>`  | `CATALYST_PEERING_ENDPOINT`         | Yes      |                 | WebSocket endpoint for iBGP peering               |
| `--port <port>`             | `PORT`                              | No       | `3000`          | Port to listen on                                 |
| `--hostname <host>`         |                                     | No       | `0.0.0.0`       | Hostname to bind to                               |
| `--domains <domains>`       | `CATALYST_DOMAINS`                  | No       |                 | Comma-separated list of trusted domains           |
| `--peering-secret <secret>` | `CATALYST_PEERING_SECRET`           | No       | `valid-secret`  | iBGP peering secret                               |
| `--keys-db <path>`          | `CATALYST_AUTH_KEYS_DB`             | No       | `keys.db`       | SQLite database path for auth keys                |
| `--tokens-db <path>`        | `CATALYST_AUTH_TOKENS_DB`           | No       | `tokens.db`     | SQLite database path for auth tokens              |
| `--revocation`              | `CATALYST_AUTH_REVOCATION`          | No       | `false`         | Enable token revocation                           |
| `--revocation-max-size <n>` | `CATALYST_AUTH_REVOCATION_MAX_SIZE` | No       |                 | Max revocation list size                          |
| `--bootstrap-token <token>` | `CATALYST_BOOTSTRAP_TOKEN`          | No       |                 | Bootstrap authentication token                    |
| `--bootstrap-ttl <ms>`      | `CATALYST_BOOTSTRAP_TTL`            | No       |                 | Bootstrap token TTL in milliseconds               |
| `--gateway-endpoint <url>`  | `CATALYST_GQL_GATEWAY_ENDPOINT`     | No       | Auto-configured | Override gateway RPC endpoint for route sync      |
| `--log-level <level>`       |                                     | No       | `info`          | Log level                                         |

## In-Process vs Separate Deployment

In composite mode, several things are handled differently from running services as separate containers:

| Concern               | Composite Mode                                            | Separate Deployment                                 |
| :-------------------- | :-------------------------------------------------------- | :-------------------------------------------------- |
| **Auth**              | Runs in-process; orchestrator skips network token minting | Auth is a separate container; tokens minted via RPC |
| **Gateway RPC**       | Auto-wired to `ws://localhost:<port>/gateway/api`         | Must configure `CATALYST_GQL_GATEWAY_ENDPOINT`      |
| **WebSocket handler** | Shared across all services via `hono/bun`                 | Each service has its own WebSocket listener         |
| **Startup order**     | Guaranteed: Auth -> Orchestrator -> Gateway               | Must be orchestrated externally (compose/k8s)       |
| **Scaling**           | Single process, single node                               | Each service scales independently                   |

## Build & Run

Requires [Bun](https://bun.sh) runtime.

```bash
# Run from source (development)
bun run dev -- --node-id my-node.example.local.io --peering-endpoint ws://localhost:3000/orchestrator/rpc

# Build with tsup (ESM-only output)
bun run build

# Run the built output
bun run start -- --node-id my-node.example.local.io --peering-endpoint ws://localhost:3000/orchestrator/rpc
```

## Environment Variable Quick Start

For environments where CLI flags are not practical (containers, systemd), set environment variables instead:

```bash
export CATALYST_NODE_ID="my-node.example.local.io"
export CATALYST_PEERING_ENDPOINT="ws://localhost:3000/orchestrator/rpc"
export PORT=3000

bun run start
```
