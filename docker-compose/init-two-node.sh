#!/usr/bin/env bash
# init-two-node.sh — Bootstrap the two-node dev cluster with auth
set -euo pipefail

COMPOSE_FILE="docker-compose/two-node.compose.yaml"
CLI="bun apps/cli/src/index.ts"
DOMAIN="dev.catalyst.local"

log() { echo "[$(date +%H:%M:%S)] $*"; }

wait_for_health() {
  local url="$1" label="$2" timeout="${3:-60}"
  local start=$SECONDS
  while (( SECONDS - start < timeout )); do
    if curl -sf "$url" > /dev/null 2>&1; then
      log "$label healthy"
      return 0
    fi
    sleep 1
  done
  echo "FATAL: $label did not become healthy within ${timeout}s" >&2
  exit 1
}

# Phase 1: Start auth + supporting services
log "Starting auth + support services..."
docker compose -f "$COMPOSE_FILE" up -d auth books-service movies-service gateway-a gateway-b envoy-service envoy-proxy otel-collector
wait_for_health "http://localhost:4020/health" "auth"

# Extract system token
log "Extracting system token..."
SYSTEM_TOKEN=$(docker compose -f "$COMPOSE_FILE" logs auth 2>&1 | grep -o 'CATALYST_SYSTEM_TOKEN=[^ ]*' | head -1 | sed 's/CATALYST_SYSTEM_TOKEN=//')
if [[ -z "$SYSTEM_TOKEN" || ${#SYSTEM_TOKEN} -lt 50 ]]; then
  echo "FATAL: Could not extract system token from auth logs" >&2
  docker compose -f "$COMPOSE_FILE" logs auth 2>&1 | tail -20
  exit 1
fi
log "System token extracted (${#SYSTEM_TOKEN} chars)"

# Phase 2: Start orchestrators with system token
log "Starting orchestrators with auth..."
CATALYST_SYSTEM_TOKEN="$SYSTEM_TOKEN" \
CATALYST_AUTH_ENDPOINT="ws://auth:4020/rpc" \
docker compose -f "$COMPOSE_FILE" up -d node-a node-b

wait_for_health "http://localhost:3001/health" "node-a"
wait_for_health "http://localhost:3002/health" "node-b"

# Phase 3: Start web-ui
log "Starting web-ui..."
docker compose -f "$COMPOSE_FILE" up -d web-ui
wait_for_health "http://localhost:8080/health" "web-ui" 30

# Phase 4: Mint tokens and register routes
log "Minting data channel token..."
DC_TOKEN=$(NO_COLOR=1 $CLI --auth-url ws://localhost:4020/rpc --token "$SYSTEM_TOKEN" \
  auth token mint route-admin --principal DATA_CUSTODIAN --name "Route Admin" \
  --type service --expires-in 24h --trusted-domains "$DOMAIN" 2>&1 | tail -1)

log "Registering books-api on node-a..."
NO_COLOR=1 $CLI --orchestrator-url ws://localhost:3001/rpc --token "$DC_TOKEN" \
  node route create books-api http://books-service:8080/graphql --protocol http:graphql 2>&1 || true

log "Registering movies-api on node-b..."
NO_COLOR=1 $CLI --orchestrator-url ws://localhost:3002/rpc --token "$DC_TOKEN" \
  node route create movies-api http://movies-service:8080/graphql --protocol http:graphql 2>&1 || true

# Phase 5: Set up peering
log "Minting peer tokens..."
PEER_TOKEN_A=$(NO_COLOR=1 $CLI --auth-url ws://localhost:4020/rpc --token "$SYSTEM_TOKEN" \
  auth token mint node-a --principal NODE --name "Node A" \
  --type service --expires-in 24h --trusted-domains "$DOMAIN" 2>&1 | tail -1)

PEER_TOKEN_B=$(NO_COLOR=1 $CLI --auth-url ws://localhost:4020/rpc --token "$SYSTEM_TOKEN" \
  auth token mint node-b --principal NODE --name "Node B" \
  --type service --expires-in 24h --trusted-domains "$DOMAIN" 2>&1 | tail -1)

log "Creating peer A→B..."
NC_TOKEN_A=$(NO_COLOR=1 $CLI --auth-url ws://localhost:4020/rpc --token "$SYSTEM_TOKEN" \
  auth token mint node-a-nc --principal NODE_CUSTODIAN --name "Node A NC" \
  --type service --expires-in 24h --trusted-domains "$DOMAIN" 2>&1 | tail -1)

NO_COLOR=1 $CLI --orchestrator-url ws://localhost:3001/rpc --token "$NC_TOKEN_A" \
  node peer create node-b.$DOMAIN ws://node-b:3000/rpc --domains "$DOMAIN" \
  --peer-token "$PEER_TOKEN_B" 2>&1 || true

log "Creating peer B→A..."
NC_TOKEN_B=$(NO_COLOR=1 $CLI --auth-url ws://localhost:4020/rpc --token "$SYSTEM_TOKEN" \
  auth token mint node-b-nc --principal NODE_CUSTODIAN --name "Node B NC" \
  --type service --expires-in 24h --trusted-domains "$DOMAIN" 2>&1 | tail -1)

NO_COLOR=1 $CLI --orchestrator-url ws://localhost:3002/rpc --token "$NC_TOKEN_B" \
  node peer create node-a.$DOMAIN ws://node-a:3000/rpc --domains "$DOMAIN" \
  --peer-token "$PEER_TOKEN_A" 2>&1 || true

# Wait for peering + route propagation
log "Waiting for route propagation..."
sleep 5

# Check state
log "=== Node A state ==="
curl -s http://localhost:3001/api/state | python3 -m json.tool 2>/dev/null || curl -s http://localhost:3001/api/state

log "=== Node B state ==="
curl -s http://localhost:3002/api/state | python3 -m json.tool 2>/dev/null || curl -s http://localhost:3002/api/state

echo ""
log "Done! Open http://localhost:8080 to see the status page."
log "System token saved — use for CLI operations:"
echo "  export CATALYST_AUTH_TOKEN=$SYSTEM_TOKEN"
