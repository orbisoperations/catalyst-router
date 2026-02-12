# 3-Stack Integration Demo

Step-by-step walkthrough for building, booting, and testing the three-node
Catalyst Router topology defined in `three-node.compose.yaml`.

All commands assume you are running from the repository root.

## Topology

```
Stack A                    Stack B                    Stack C
+-----------------+        +-----------------+        +-----------------+
| auth-a   :5001  |        | auth-b   :5002  |        | auth-c   :5003  |
| orch-a   :3001  |        | orch-b   :3002  |        | orch-c   :3003  |
| envoy-a  :10001 |        | envoy-b  :10002 |        | envoy-c  :10003 |
| books-a         |        | books-b         |        | curl-client     |
+-----------------+        +-----------------+        +-----------------+
        |                         |                         |
        +-------orchestrator-mesh-+-----------+-------------+
        +-------envoy-mesh--------+-----------+-------------+
```

| Stack | Auth   | Orchestrator   | Envoy Proxy   | Downstream  |
| ----- | ------ | -------------- | ------------- | ----------- |
| A     | auth-a | orchestrator-a | envoy-proxy-a | books-a     |
| B     | auth-b | orchestrator-b | envoy-proxy-b | books-b     |
| C     | auth-c | orchestrator-c | envoy-proxy-c | curl-client |

All three orchestrators share the domain `somebiz.local.io` and peer over the
`orchestrator-mesh` network. Envoy proxies peer over the `envoy-mesh` network.

Peering topology: **A <-> B <-> C** (B acts as transit; full mesh is not required).

## Prerequisites

- Docker Engine 24+ and Docker Compose v2
- ~4 GB free RAM (14 containers)
- Ports 3001-3003, 5001-5003, 9911-9913, 10001-10003, 10011-10012, 10021-10022, 10031-10032 available on the host
- [Bun](https://bun.sh) installed (for running CLI commands)
- Clone of this repository with dependencies installed (`bun install`)

**Note:** Healthchecks in the compose file use `127.0.0.1` instead of
`localhost` because Alpine resolves `localhost` to IPv6 `::1`, while Bun
binds to IPv4 only.

## Host Port Reference

| Service            | Stack A | Stack B | Stack C |
| ------------------ | ------- | ------- | ------- |
| Auth               | 5001    | 5002    | 5003    |
| Orchestrator       | 3001    | 3002    | 3003    |
| Envoy Admin        | 9911    | 9912    | 9913    |
| Envoy Proxy :10000 | 10001   | 10002   | 10003   |
| Envoy Proxy :10001 | 10011   | 10021   | 10031   |
| Envoy Proxy :10002 | 10012   | 10022   | 10032   |

---

## Step 1: Build

Build all images. This runs a single `bun install` in the base stage and
creates per-service targets (auth, orchestrator, envoy, books-api).

```bash
docker compose -f docker-compose/three-node.compose.yaml build
```

## Step 2: Start Auth Services

Start only the three auth services. Each mints a System Admin Token on startup
and logs it to stdout.

```bash
docker compose -f docker-compose/three-node.compose.yaml up -d auth-a auth-b auth-c
```

Wait for all three to become healthy before proceeding:

```bash
docker compose -f docker-compose/three-node.compose.yaml ps auth-a auth-b auth-c
```

All three should show `healthy` status.

## Step 3: Extract and Export Tokens

Extract the system tokens from the auth service logs and export them as
environment variables. The orchestrators read these on startup to authenticate
with their local auth service.

```bash
export SYSTEM_TOKEN_A=$(docker compose -f docker-compose/three-node.compose.yaml logs auth-a 2>&1 \
  | grep -o 'System Admin Token minted: ey[^ ]*' | head -1 \
  | sed 's/System Admin Token minted: //')

export SYSTEM_TOKEN_B=$(docker compose -f docker-compose/three-node.compose.yaml logs auth-b 2>&1 \
  | grep -o 'System Admin Token minted: ey[^ ]*' | head -1 \
  | sed 's/System Admin Token minted: //')

export SYSTEM_TOKEN_C=$(docker compose -f docker-compose/three-node.compose.yaml logs auth-c 2>&1 \
  | grep -o 'System Admin Token minted: ey[^ ]*' | head -1 \
  | sed 's/System Admin Token minted: //')
```

Verify the tokens were captured:

```bash
echo "Token A: ${SYSTEM_TOKEN_A:0:20}..."
echo "Token B: ${SYSTEM_TOKEN_B:0:20}..."
echo "Token C: ${SYSTEM_TOKEN_C:0:20}..."
```

Each line should show the first 20 characters of a JWT (starting with `eyJ`).
If any token is empty, re-check that the corresponding auth service is healthy
and re-run the export command.

## Step 4: Start All Services

With the tokens exported, bring up the full stack. The orchestrators use
`SYSTEM_TOKEN_A`/`B`/`C` to mint their own NODE tokens via their local auth
service.

```bash
docker compose -f docker-compose/three-node.compose.yaml up -d
```

Wait for every service to become healthy:

```bash
docker compose -f docker-compose/three-node.compose.yaml ps
```

The orchestrators start last because they depend on auth, envoy-svc,
envoy-proxy, and books (or curl-client) being healthy first.

## Step 5: Register Routes

Register the books-api service as a local route on orchestrators A and B.
The `books` hostname is a Docker network alias that resolves within each
stack's data network.

```bash
bun run apps/cli/src/index.ts \
  --orchestrator-url ws://localhost:3001/rpc \
  --token "$SYSTEM_TOKEN_A" \
  node route create books-a http://books:8080 --protocol http:graphql
```

```bash
bun run apps/cli/src/index.ts \
  --orchestrator-url ws://localhost:3002/rpc \
  --token "$SYSTEM_TOKEN_B" \
  node route create books-b http://books:8080 --protocol http:graphql
```

Verify on stack A:

```bash
bun run apps/cli/src/index.ts \
  --orchestrator-url ws://localhost:3001/rpc \
  --token "$SYSTEM_TOKEN_A" \
  node route list
```

Expected output: a table showing `books-a` with source `local` and protocol
`http:graphql`.

## Step 6: Peer the Orchestrators

Each stack has its own auth server, so peering requires **peer tokens** -- a
token minted by the remote stack's auth service that the local node presents
when connecting.

Peering topology: **A <-> B <-> C** (B is the transit node).

### 6a. Mint Peer Tokens

Mint tokens on each auth server for the remote nodes that will connect:

```bash
# Auth-A mints a token for node-b (so node-b can authenticate when connecting to orch-a)
PEER_TOKEN_B_ON_A=$(bun run apps/cli/src/index.ts \
  --auth-url ws://localhost:5001/rpc \
  --token "$SYSTEM_TOKEN_A" \
  auth token mint node-b.somebiz.local.io \
  --principal CATALYST::NODE --type service \
  --trusted-domains somebiz.local.io --expires-in 7d 2>/dev/null | tail -1)

# Auth-B mints a token for node-a (so node-a can authenticate when connecting to orch-b)
PEER_TOKEN_A_ON_B=$(bun run apps/cli/src/index.ts \
  --auth-url ws://localhost:5002/rpc \
  --token "$SYSTEM_TOKEN_B" \
  auth token mint node-a.somebiz.local.io \
  --principal CATALYST::NODE --type service \
  --trusted-domains somebiz.local.io --expires-in 7d 2>/dev/null | tail -1)

# Auth-B mints a token for node-c
PEER_TOKEN_C_ON_B=$(bun run apps/cli/src/index.ts \
  --auth-url ws://localhost:5002/rpc \
  --token "$SYSTEM_TOKEN_B" \
  auth token mint node-c.somebiz.local.io \
  --principal CATALYST::NODE --type service \
  --trusted-domains somebiz.local.io --expires-in 7d 2>/dev/null | tail -1)

# Auth-C mints a token for node-b
PEER_TOKEN_B_ON_C=$(bun run apps/cli/src/index.ts \
  --auth-url ws://localhost:5003/rpc \
  --token "$SYSTEM_TOKEN_C" \
  auth token mint node-b.somebiz.local.io \
  --principal CATALYST::NODE --type service \
  --trusted-domains somebiz.local.io --expires-in 7d 2>/dev/null | tail -1)
```

Verify the tokens:

```bash
echo "PEER_TOKEN_B_ON_A: ${PEER_TOKEN_B_ON_A:0:20}..."
echo "PEER_TOKEN_A_ON_B: ${PEER_TOKEN_A_ON_B:0:20}..."
echo "PEER_TOKEN_C_ON_B: ${PEER_TOKEN_C_ON_B:0:20}..."
echo "PEER_TOKEN_B_ON_C: ${PEER_TOKEN_B_ON_C:0:20}..."
```

### 6b. Create Peer Connections

Peer endpoints use Docker network aliases (`orch-a`, `orch-b`, `orch-c`) that
resolve on the `orchestrator-mesh` network. Both sides of each peering
relationship must be configured.

```bash
# A peers with B (A presents PEER_TOKEN_A_ON_B to authenticate with B's auth)
bun run apps/cli/src/index.ts \
  --orchestrator-url ws://localhost:3001/rpc \
  --token "$SYSTEM_TOKEN_A" \
  node peer create node-b.somebiz.local.io ws://orch-b:3000/rpc \
  --domains somebiz.local.io \
  --peer-token "$PEER_TOKEN_A_ON_B"

# B peers with A (B presents PEER_TOKEN_B_ON_A to authenticate with A's auth)
bun run apps/cli/src/index.ts \
  --orchestrator-url ws://localhost:3002/rpc \
  --token "$SYSTEM_TOKEN_B" \
  node peer create node-a.somebiz.local.io ws://orch-a:3000/rpc \
  --domains somebiz.local.io \
  --peer-token "$PEER_TOKEN_B_ON_A"

# B peers with C
bun run apps/cli/src/index.ts \
  --orchestrator-url ws://localhost:3002/rpc \
  --token "$SYSTEM_TOKEN_B" \
  node peer create node-c.somebiz.local.io ws://orch-c:3000/rpc \
  --domains somebiz.local.io \
  --peer-token "$PEER_TOKEN_B_ON_C"

# C peers with B
bun run apps/cli/src/index.ts \
  --orchestrator-url ws://localhost:3003/rpc \
  --token "$SYSTEM_TOKEN_C" \
  node peer create node-b.somebiz.local.io ws://orch-b:3000/rpc \
  --domains somebiz.local.io \
  --peer-token "$PEER_TOKEN_C_ON_B"
```

Verify peering on node A:

```bash
bun run apps/cli/src/index.ts \
  --orchestrator-url ws://localhost:3001/rpc \
  --token "$SYSTEM_TOKEN_A" \
  node peer list
```

Expected output: a table showing `node-b.somebiz.local.io` with `connected`
status.

## Step 7: Verify Route Propagation

After peering, routes advertised on A and B should propagate through B to C.
Check that orchestrator C (which has no local books service) sees both routes
as `internal`:

```bash
bun run apps/cli/src/index.ts \
  --orchestrator-url ws://localhost:3003/rpc \
  --token "$SYSTEM_TOKEN_C" \
  node route list
```

Expected output: a table showing `books-a` and `books-b` with source
`internal`, learned from peer `node-b.somebiz.local.io`.

## Step 8: Test End-to-End

### From the curl-client container

The curl-client sits on stack C's data network. It can reach envoy-proxy-c,
which routes the request across the envoy-mesh to a books service on stack A
or B.

```bash
docker compose -f docker-compose/three-node.compose.yaml exec curl-client \
  curl -s http://envoy-proxy-c:10000/graphql \
  -H "Content-Type: application/json" \
  -d '{"query": "{ books { id title author } }"}'
```

### From the host

Send a GraphQL query through envoy-proxy-c (host port 10003). This tests the
same cross-node path from outside the Docker network:

```bash
curl -s http://localhost:10003/graphql \
  -H "Content-Type: application/json" \
  -d '{"query": "{ books { id title author } }"}'
```

Expected response from either command:

```json
{
  "data": {
    "books": [
      { "id": "1", "title": "The Lord of the Rings", "author": "J.R.R. Tolkien" },
      { "id": "2", "title": "Pride and Prejudice", "author": "Jane Austen" },
      { "id": "3", "title": "The Hobbit", "author": "J.R.R. Tolkien" }
    ]
  }
}
```

Stack C has no books service of its own -- if you get a response, cross-node
routing is working.

## Step 9: Verify Cross-Node Routing

Use verbose output to confirm the request is being routed through Envoy across
stacks:

```bash
docker compose -f docker-compose/three-node.compose.yaml exec curl-client \
  curl -v http://envoy-proxy-c:10000/graphql \
  -H "Host: books-a.somebiz.local.io" \
  -H "Content-Type: application/json" \
  -d '{"query": "{ books { id title author } }"}'
```

The `-v` flag shows the upstream connection details. Look for response headers
indicating the request was proxied through Envoy to stack A.

## Step 10: Teardown

Stop all containers, remove networks, and clean up volumes:

```bash
docker compose -f docker-compose/three-node.compose.yaml down -v
```

To also remove the built images:

```bash
docker compose -f docker-compose/three-node.compose.yaml down -v --rmi local
```
