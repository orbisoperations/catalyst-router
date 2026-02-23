# Docker UAT: Two-Node Peering Runbook

This runbook covers running two Catalyst nodes in Docker for peering UAT. Two setups are provided:

1. **Composite mode** (recommended) -- each node is a single container running all services
2. **Individual mode** -- each node is a group of separate auth, orchestrator, and gateway containers

Composite mode is how we will be using this most often.

## Prerequisites

- Docker and Docker Compose installed (Compose V2 recommended)
- All commands must be run from the **repository root** directory
- Ports 3001, 3002 (composite) or 3001, 3002, 4000, 4001, 4020, 4021 (individual) must be free
- `curl` available for health check and verification commands

## Composite Mode (Primary)

Each node runs auth, orchestrator, and gateway in a single container. Two containers total plus one subgraph per node.

### Step 1: Build and Start

```bash
docker compose -f docker-compose/two-node-composite.compose.yaml up --build -d
```

The `--build` flag rebuilds images from source. The `-d` flag runs containers in the background so you can run validation commands in the same terminal.

### Step 2: Wait for Services

Services take approximately 20-30 seconds to become healthy. Check container status:

```bash
docker compose -f docker-compose/two-node-composite.compose.yaml ps
```

Wait until all containers show `healthy` in the STATUS column. If a container shows `starting`, wait and re-run the command. Example healthy output:

```
NAME             STATUS
node-a           Up 30s (healthy)
node-b           Up 30s (healthy)
books-service    Up 30s (healthy)
movies-service   Up 30s (healthy)
```

### Step 3: Verify Health

Check that both nodes report healthy with all three services running:

```bash
curl -s http://localhost:3001/health
```

Expected output:

```
{"status":"ok","services":["auth","gateway","orchestrator"]}
```

```bash
curl -s http://localhost:3002/health
```

Expected output:

```
{"status":"ok","services":["auth","gateway","orchestrator"]}
```

### Step 4: Check Node Info

Query the root endpoint for node metadata:

```bash
curl -s http://localhost:3001/ | python3 -m json.tool
```

Expected output:

```json
{
  "service": "catalyst-node",
  "version": "1.0.0",
  "nodeId": "node-a.somebiz.local.io",
  "mounts": {
    "auth": "/auth",
    "orchestrator": "/orchestrator",
    "gateway": "/gateway"
  }
}
```

```bash
curl -s http://localhost:3002/ | python3 -m json.tool
```

Expected output:

```json
{
  "service": "catalyst-node",
  "version": "1.0.0",
  "nodeId": "node-b.somebiz.local.io",
  "mounts": {
    "auth": "/auth",
    "orchestrator": "/orchestrator",
    "gateway": "/gateway"
  }
}
```

### Step 5: View Logs

Check startup and peering logs to confirm services initialized and nodes discovered each other:

```bash
docker compose -f docker-compose/two-node-composite.compose.yaml logs
```

Look for these log patterns indicating successful startup:

```
catalyst.auth: auth v0.0.0 initialized
catalyst.gateway: gateway v0.0.0 initialized
catalyst.node: Catalyst composite node listening on 0.0.0.0:3000
catalyst.orchestrator: orchestrator v0.0.0 initialized
catalyst.node: All services ready: auth, gateway, orchestrator
```

To follow logs in real time (useful while waiting for peering to establish):

```bash
docker compose -f docker-compose/two-node-composite.compose.yaml logs -f
```

Press `Ctrl+C` to stop following.

### Step 6: Teardown

Stop and remove all containers and networks:

```bash
docker compose -f docker-compose/two-node-composite.compose.yaml down
```

---

## Individual Mode

Each node has separate containers for auth, orchestrator, and gateway. More containers, but allows testing service-level isolation and debugging individual services.

### Step 1: Build and Start

```bash
docker compose -f docker-compose/two-node-individual.compose.yaml up --build -d
```

This starts 8 containers: auth, orchestrator, gateway, and subgraph for each node.

### Step 2: Wait for Services

Services take approximately 30-45 seconds to become healthy due to dependency ordering (subgraphs start first, then auth and gateway, then orchestrators last).

```bash
docker compose -f docker-compose/two-node-individual.compose.yaml ps
```

Wait until all 8 containers show `healthy` in the STATUS column.

### Step 3: Verify Health

Check orchestrators:

```bash
curl -s http://localhost:3001/health
```

```bash
curl -s http://localhost:3002/health
```

Check gateways:

```bash
curl -s http://localhost:4000/health
```

```bash
curl -s http://localhost:4001/health
```

Check auth services:

```bash
curl -s http://localhost:4020/health
```

```bash
curl -s http://localhost:4021/health
```

All health endpoints should return a JSON response with `"status":"ok"`.

### Step 4: View Logs

Check orchestrator logs specifically for peering activity:

```bash
docker compose -f docker-compose/two-node-individual.compose.yaml logs orchestrator-a orchestrator-b
```

To view logs for all services:

```bash
docker compose -f docker-compose/two-node-individual.compose.yaml logs
```

To follow logs in real time:

```bash
docker compose -f docker-compose/two-node-individual.compose.yaml logs -f
```

### Step 5: Teardown

```bash
docker compose -f docker-compose/two-node-individual.compose.yaml down
```

---

## Network Architecture

### Composite Mode

Two composite node containers, each on their own isolated network, with a shared peering network for cross-node orchestrator RPC.

```
┌─────────────────────┐         ┌─────────────────────┐
│     node-a-net      │         │     node-b-net      │
│                     │         │                     │
│  ┌───────────────┐  │         │  ┌───────────────┐  │
│  │    node-a     │  │         │  │    node-b     │  │
│  │ :3001 → :3000 │  │         │  │ :3002 → :3000 │  │
│  │               │  │         │  │               │  │
│  │  auth         │  │         │  │  auth         │  │
│  │  orchestrator─┼──┼─peering─┼──┼─orchestrator  │  │
│  │  gateway      │  │         │  │  gateway      │  │
│  └───────────────┘  │         │  └───────────────┘  │
│                     │         │                     │
│  ┌───────────────┐  │         │  ┌───────────────┐  │
│  │ books-service │  │         │  │ movies-service│  │
│  └───────────────┘  │         │  └───────────────┘  │
└─────────────────────┘         └─────────────────────┘
```

### Individual Mode

Each node has its own auth, orchestrator, and gateway containers. Only orchestrators share the peering network.

```
┌──────────────────────────┐         ┌──────────────────────────┐
│       node-a-net         │         │       node-b-net         │
│                          │         │                          │
│  ┌────────┐ ┌─────────┐ │         │ ┌─────────┐ ┌────────┐  │
│  │ auth-a │ │gateway-a│ │         │ │gateway-b│ │ auth-b │  │
│  │ :4020  │ │ :4000   │ │         │ │ :4001   │ │ :4021  │  │
│  └────────┘ └─────────┘ │         │ └─────────┘ └────────┘  │
│                          │         │                          │
│  ┌──────────────────┐   │         │   ┌──────────────────┐  │
│  │  orchestrator-a  │   │         │   │  orchestrator-b  │  │
│  │  :3001           ├───┼─peering─┼───┤  :3002           │  │
│  └──────────────────┘   │         │   └──────────────────┘  │
│                          │         │                          │
│  ┌──────────────────┐   │         │   ┌──────────────────┐  │
│  │  books-service   │   │         │   │  movies-service  │  │
│  └──────────────────┘   │         │   └──────────────────┘  │
└──────────────────────────┘         └──────────────────────────┘
```

## How Peering Works

Both nodes share the same `CATALYST_PEERING_SECRET` and `CATALYST_DOMAINS`, which allows them to establish a BGP-inspired peering session over WebSocket.

1. Each orchestrator advertises its `CATALYST_PEERING_ENDPOINT` -- the WebSocket URL where peers can connect
2. When two orchestrators discover each other, they establish a bidirectional RPC session over the `peering` network
3. Service routes are exchanged: Node A advertises the books subgraph, Node B advertises the movies subgraph
4. After route exchange, either node's gateway can federate queries across both subgraphs

### Composite vs Individual Peering Endpoints

In **composite mode**, the orchestrator's RPC endpoint is mounted at a sub-path:

```
ws://node-a:3000/orchestrator/rpc
```

In **individual mode**, the orchestrator runs standalone so the RPC endpoint is at the root:

```
ws://orchestrator-a:3000/rpc
```

## When to Use Which Setup

| Setup      | Use When                                                                  |
| :--------- | :------------------------------------------------------------------------ |
| Composite  | Testing the primary deployment pattern, quick iteration, fewer containers |
| Individual | Testing service-level isolation, debugging specific services, CI/CD       |

## Environment Variables

Environment variables used in the compose files. These are pre-configured in the YAML files and do not need manual setup for UAT.

| Variable                        | Description                                        | Composite Example                   | Individual Example                   |
| :------------------------------ | :------------------------------------------------- | :---------------------------------- | :----------------------------------- |
| `PORT`                          | Internal listen port for the container             | `3000`                              | `3000` (orchestrator), `5000` (auth) |
| `CATALYST_NODE_ID`              | Unique node identifier                             | `node-a.somebiz.local.io`           | `node-a.somebiz.local.io`            |
| `CATALYST_PEERING_ENDPOINT`     | WebSocket URL advertised to peers                  | `ws://node-a:3000/orchestrator/rpc` | `ws://orchestrator-a:3000/rpc`       |
| `CATALYST_DOMAINS`              | Comma-separated list of peering domains            | `somebiz.local.io`                  | `somebiz.local.io`                   |
| `CATALYST_PEERING_SECRET`       | Shared secret for peer authentication              | `valid-secret`                      | `valid-secret`                       |
| `CATALYST_AUTH_KEYS_DB`         | Path to auth keys database (composite only)        | `/app/data/keys.db`                 | N/A                                  |
| `CATALYST_AUTH_TOKENS_DB`       | Path to auth tokens database (composite only)      | `/app/data/tokens.db`               | N/A                                  |
| `CATALYST_AUTH_ENDPOINT`        | WebSocket URL of auth service (individual only)    | N/A                                 | `ws://auth-a:5000/rpc`               |
| `CATALYST_GQL_GATEWAY_ENDPOINT` | WebSocket URL of gateway service (individual only) | N/A                                 | `ws://gateway-a:4000/api`            |

## Troubleshooting

### Port Conflicts

If `docker compose up` fails with "port is already allocated", check what is using the port:

```bash
lsof -i :3001
```

Either stop the conflicting process or change the host port mapping in the compose file.

### Health Check Timeouts

If containers stay in `starting` or transition to `unhealthy`:

1. Check logs for the specific container:

```bash
docker compose -f docker-compose/two-node-composite.compose.yaml logs node-a
```

2. Verify the health check endpoint is responding inside the container:

```bash
docker compose -f docker-compose/two-node-composite.compose.yaml exec node-a wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/health
```

3. Health checks are configured with a 10-second interval and 5 retries, so containers have up to 50 seconds to become healthy.

### Build Failures

If the build step fails:

1. Ensure all dependencies are installed locally first:

```bash
bun install
```

2. Rebuild without cache to pick up Dockerfile changes:

```bash
docker compose -f docker-compose/two-node-composite.compose.yaml build --no-cache
```

### Container Shows "Unhealthy"

Inspect the health check output directly:

```bash
docker inspect --format='{{json .State.Health}}' <container-name>
```

This shows the last health check result including any error messages.

### Peering Not Establishing

If nodes start but do not peer:

1. Verify both nodes share the same `CATALYST_PEERING_SECRET` and `CATALYST_DOMAINS` (check the compose file)
2. Confirm orchestrators can reach each other over the `peering` network:

```bash
docker compose -f docker-compose/two-node-composite.compose.yaml exec node-a wget --no-verbose --tries=1 --spider http://node-b:3000/health
```

3. Check orchestrator logs for peering-related errors:

```bash
docker compose -f docker-compose/two-node-composite.compose.yaml logs | grep -i peer
```
