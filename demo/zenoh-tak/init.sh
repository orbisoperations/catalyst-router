#!/usr/bin/env bash
# init.sh — Bootstrap script for the Zenoh 3-node demo.
#
# Starts containers in order, mints tokens, and configures peering — mirroring
# a realistic Catalyst deployment:
#
#   Phase 1: Start auth services, extract system admin tokens
#   Phase 2: Start orchestrators + envoy (with system tokens), start zenoh + TAK
#   Phase 3: Mint peer tokens, establish BGP peering (A <-> B, B <-> C)
#   Phase 4: Create Zenoh TCP route, wait for xDS propagation
#
# Uses the Catalyst CLI (`bun apps/cli/src/index.ts`) for all token and
# orchestrator operations — same interface as a real deployment.
#
# Usage:
#   bash demo/zenoh-tak/init.sh
set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DOMAIN="somebiz.local.io"
COMPOSE_FILE="demo/zenoh-tak/docker-compose.yaml"
CLI="bun apps/cli/src/index.ts"

# Node A
NODE_A_ID="node-a.${DOMAIN}"
AUTH_A_URL="ws://localhost:5050/rpc"
AUTH_A_HEALTH="http://localhost:5050/health"
ORCH_A_URL="ws://localhost:3001/rpc"
ORCH_A_INTERNAL="ws://orch-a:3000/rpc"
ORCH_A_HEALTH="http://localhost:3001/health"
ENVOY_A_ADMIN="http://localhost:9901"

# Node B
NODE_B_ID="node-b.${DOMAIN}"
AUTH_B_URL="ws://localhost:5051/rpc"
AUTH_B_HEALTH="http://localhost:5051/health"
ORCH_B_URL="ws://localhost:3002/rpc"
ORCH_B_INTERNAL="ws://orch-b:3000/rpc"
ORCH_B_HEALTH="http://localhost:3002/health"
ENVOY_B_ADMIN="http://localhost:9902"

# Node C
NODE_C_ID="node-c.${DOMAIN}"
AUTH_C_URL="ws://localhost:5052/rpc"
AUTH_C_HEALTH="http://localhost:5052/health"
ORCH_C_URL="ws://localhost:3003/rpc"
ORCH_C_INTERNAL="ws://orch-c:3000/rpc"
ORCH_C_HEALTH="http://localhost:3003/health"
ENVOY_C_ADMIN="http://localhost:9903"

HEALTH_TIMEOUT=60
PEER_TIMEOUT=30
XDS_TIMEOUT=60

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

log() { echo "[$(date +%H:%M:%S.%3N)] $*"; }
fail() { echo -e "\nFATAL: $*" >&2; exit 1; }

wait_for_health() {
  local url="$1" label="$2" timeout="${3:-$HEALTH_TIMEOUT}"
  local start=$SECONDS
  while (( SECONDS - start < timeout )); do
    if curl -sf "$url" > /dev/null 2>&1; then
      log "$label healthy"
      return 0
    fi
    sleep 1
  done
  fail "$label did not become healthy within ${timeout}s"
}

extract_system_token() {
  local service="$1"
  local logs
  logs=$(docker compose -f "$COMPOSE_FILE" logs "$service" 2>/dev/null | sed $'s/\x1b\\[[0-9;]*m//g')
  local token
  token=$(echo "$logs" | grep -o 'System Admin Token minted: [^ ]*' | head -1 | sed 's/System Admin Token minted: //')
  if [[ -z "$token" ]]; then
    fail "Could not find system token in $service logs.
Try: docker compose -f $COMPOSE_FILE logs $service | grep 'System Admin Token'"
  fi
  echo "$token"
}

# Mint a token via the CLI. Captures the token from the second line of output.
mint_token() {
  local auth_url="$1" admin_token="$2" subject="$3" principal="$4"
  local name="${5:-$subject}" type="${6:-service}" expires="${7:-24h}"
  local trusted_domains="${8:-$DOMAIN}"

  local output
  output=$(NO_COLOR=1 $CLI \
    --auth-url "$auth_url" \
    --token "$admin_token" \
    auth token mint "$subject" \
    --principal "$principal" \
    --name "$name" \
    --type "$type" \
    --expires-in "$expires" \
    --trusted-domains "$trusted_domains" 2>&1) || fail "Failed to mint token for $subject: $output"

  # Token is on the last line of output
  echo "$output" | tail -1
}

# Create a peer via the CLI
create_peer() {
  local orch_url="$1" token="$2" peer_name="$3" peer_endpoint="$4"
  local domains="$5" peer_token="$6"

  NO_COLOR=1 $CLI \
    --orchestrator-url "$orch_url" \
    --token "$token" \
    node peer create "$peer_name" "$peer_endpoint" \
    --domains "$domains" \
    --peer-token "$peer_token" || fail "Failed to create peer $peer_name on $orch_url"
}

# Wait for a specific peer to reach "connected" status
wait_for_peer() {
  local orch_url="$1" token="$2" peer_name="$3" timeout="${4:-$PEER_TIMEOUT}"
  local start=$SECONDS
  while (( SECONDS - start < timeout )); do
    local output
    output=$(NO_COLOR=1 $CLI \
      --orchestrator-url "$orch_url" \
      --token "$token" \
      node peer list 2>&1) || true
    if echo "$output" | grep -q "$peer_name" && echo "$output" | grep "$peer_name" | grep -q "connected"; then
      return 0
    fi
    sleep 0.5
  done
  fail "Peer $peer_name did not connect within ${timeout}s"
}

# Create a route via the CLI
create_route() {
  local orch_url="$1" token="$2" name="$3" endpoint="$4" protocol="$5"

  NO_COLOR=1 $CLI \
    --orchestrator-url "$orch_url" \
    --token "$token" \
    node route create "$name" "$endpoint" \
    --protocol "$protocol" || fail "Failed to create route $name"
}

# Wait for an Envoy listener to appear
wait_for_listener() {
  local admin_url="$1" listener_name="$2" label="$3" timeout="${4:-$XDS_TIMEOUT}"
  local start=$SECONDS
  while (( SECONDS - start < timeout )); do
    if curl -sf "${admin_url}/listeners?format=json" 2>/dev/null | grep -q "$listener_name"; then
      log "$label: listener '$listener_name' ready"
      return 0
    fi
    sleep 0.5
  done
  fail "$label: timed out waiting for listener '$listener_name' (${timeout}s)"
}

compose_up() {
  docker compose -f "$COMPOSE_FILE" up -d "$@"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

echo
echo "============================================================"
echo "  Zenoh TAK 3-Node Demo — Bootstrap"
echo "============================================================"
echo

# ── Build all images upfront ───────────────────────────────────
# Building separately avoids docker compose recreating dependent containers
# (e.g. `--build orch-a` would recreate auth-a, invalidating system tokens).

log "Building all images..."
docker compose -f "$COMPOSE_FILE" build

# ── Phase 1: Auth services ──────────────────────────────────────

log "Phase 1: Starting auth services..."
compose_up auth-a auth-b auth-c

log "  Waiting for auth services..."
wait_for_health "$AUTH_A_HEALTH" "auth-a"
wait_for_health "$AUTH_B_HEALTH" "auth-b"
wait_for_health "$AUTH_C_HEALTH" "auth-c"

log "  Extracting system admin tokens..."
SYSTEM_TOKEN_A=$(extract_system_token auth-a)
SYSTEM_TOKEN_B=$(extract_system_token auth-b)
SYSTEM_TOKEN_C=$(extract_system_token auth-c)
log "  auth-a: ${SYSTEM_TOKEN_A:0:20}..."
log "  auth-b: ${SYSTEM_TOKEN_B:0:20}..."
log "  auth-c: ${SYSTEM_TOKEN_C:0:20}..."

# ── Phase 2: Envoy + orchestrators + Zenoh + TAK ────────────────

log "Phase 2: Starting envoy, orchestrators, zenoh, and TAK adapters..."

# Envoy services and proxies (no auth needed)
compose_up envoy-svc-a envoy-svc-b envoy-svc-c \
           envoy-proxy-a envoy-proxy-b envoy-proxy-c

# Orchestrators — pass each node's system token
log "  Starting orchestrators with system tokens..."
CATALYST_SYSTEM_TOKEN="$SYSTEM_TOKEN_A" compose_up orch-a
CATALYST_SYSTEM_TOKEN="$SYSTEM_TOKEN_B" compose_up orch-b
CATALYST_SYSTEM_TOKEN="$SYSTEM_TOKEN_C" compose_up orch-c

# Zenoh router and TAK adapters
compose_up zenoh-router tak-adapter-publisher tak-adapter-consumer

log "  Waiting for orchestrators..."
wait_for_health "$ORCH_A_HEALTH" "orch-a"
wait_for_health "$ORCH_B_HEALTH" "orch-b"
wait_for_health "$ORCH_C_HEALTH" "orch-c"

# ── Phase 3: Peer tokens + BGP peering ──────────────────────────

log "Phase 3: Minting peer tokens and establishing BGP peering..."

# Mint peer tokens — each auth mints a NODE token for the remote peer
log "  Minting peer tokens..."
PEER_TOKEN_A_FOR_B=$(mint_token "$AUTH_A_URL" "$SYSTEM_TOKEN_A" "$NODE_B_ID" "CATALYST::NODE")
log "    auth-a -> node-b: minted"
PEER_TOKEN_B_FOR_A=$(mint_token "$AUTH_B_URL" "$SYSTEM_TOKEN_B" "$NODE_A_ID" "CATALYST::NODE")
log "    auth-b -> node-a: minted"
PEER_TOKEN_B_FOR_C=$(mint_token "$AUTH_B_URL" "$SYSTEM_TOKEN_B" "$NODE_C_ID" "CATALYST::NODE")
log "    auth-b -> node-c: minted"
PEER_TOKEN_C_FOR_B=$(mint_token "$AUTH_C_URL" "$SYSTEM_TOKEN_C" "$NODE_B_ID" "CATALYST::NODE")
log "    auth-c -> node-b: minted"

# Establish peering
log "  Establishing BGP peering (A <-> B, B <-> C)..."

log "    B registers peer A (B presents token signed by auth-A)..."
create_peer "$ORCH_B_URL" "$SYSTEM_TOKEN_B" "$NODE_A_ID" "$ORCH_A_INTERNAL" "$DOMAIN" "$PEER_TOKEN_A_FOR_B"

log "    A registers peer B (A presents token signed by auth-B)..."
create_peer "$ORCH_A_URL" "$SYSTEM_TOKEN_A" "$NODE_B_ID" "$ORCH_B_INTERNAL" "$DOMAIN" "$PEER_TOKEN_B_FOR_A"

log "    C registers peer B (C presents token signed by auth-B)..."
create_peer "$ORCH_C_URL" "$SYSTEM_TOKEN_C" "$NODE_B_ID" "$ORCH_B_INTERNAL" "$DOMAIN" "$PEER_TOKEN_B_FOR_C"

log "    B registers peer C (B presents token signed by auth-C)..."
create_peer "$ORCH_B_URL" "$SYSTEM_TOKEN_B" "$NODE_C_ID" "$ORCH_C_INTERNAL" "$DOMAIN" "$PEER_TOKEN_C_FOR_B"

# Wait for BGP handshakes
log "  Waiting for peering handshakes..."
sleep 1
wait_for_peer "$ORCH_A_URL" "$SYSTEM_TOKEN_A" "$NODE_B_ID"
wait_for_peer "$ORCH_B_URL" "$SYSTEM_TOKEN_B" "$NODE_A_ID"
wait_for_peer "$ORCH_B_URL" "$SYSTEM_TOKEN_B" "$NODE_C_ID"
wait_for_peer "$ORCH_C_URL" "$SYSTEM_TOKEN_C" "$NODE_B_ID"
log "  BGP peering established: A <-> B <-> C"

# ── Phase 4: Route + xDS ────────────────────────────────────────

log "Phase 4: Creating Zenoh TCP route and waiting for xDS propagation..."

create_route "$ORCH_A_URL" "$SYSTEM_TOKEN_A" "zenoh-router" "http://zenoh-router:7447" "tcp"
log "  Route: zenoh-router (tcp) -> http://zenoh-router:7447"

# Wait for Envoy listeners
wait_for_listener "$ENVOY_A_ADMIN" "ingress_zenoh-router" "Envoy A"
wait_for_listener "$ENVOY_B_ADMIN" "egress_zenoh-router_via_${NODE_A_ID}" "Envoy B"
wait_for_listener "$ENVOY_C_ADMIN" "egress_zenoh-router_via_${NODE_B_ID}" "Envoy C"

# ── Done ─────────────────────────────────────────────────────────

echo
echo "============================================================"
echo "  Bootstrap Complete"
echo "============================================================"
echo
echo "  Topology:"
echo
echo "    tak-adapter-publisher (emulators: wiesbaden, virginia)"
echo "           |"
echo "      zenoh-router (:7447)"
echo "           |"
echo "    [ Node A ] auth-a + orch-a + envoy-proxy-a"
echo "           |"
echo "    [ Node B ] auth-b + orch-b + envoy-proxy-b  (transit)"
echo "           |"
echo "    [ Node C ] auth-c + orch-c + envoy-proxy-c"
echo "           |"
echo "    tak-adapter-consumer (subscribes via TCP passthrough)"
echo
echo "  Token flow:"
echo "    Phase 1: auth-{a,b,c} auto-minted system admin tokens"
echo "    Phase 2: orchestrators started with system tokens -> minted NODE tokens"
echo "    Phase 3: auth-a minted peer token for node-b"
echo "             auth-b minted peer tokens for node-a and node-c"
echo "             auth-c minted peer token for node-b"
echo
echo "  Traffic path: consumer zenohd -> C -> B -> A -> zenoh-router (:7447)"
echo
echo "  Verify:"
echo "    curl -s ${ENVOY_A_ADMIN}/listeners?format=json | jq ."
echo "    docker compose -f ${COMPOSE_FILE} logs tak-adapter-publisher --follow"
echo "    docker compose -f ${COMPOSE_FILE} logs tak-adapter-consumer --follow"
echo
