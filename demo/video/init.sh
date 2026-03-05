#!/usr/bin/env bash
# init.sh — Bootstrap script for the Video 2-node demo.
#
# Starts containers in order, mints tokens, and configures peering:
#
#   Phase 1: Start auth services, extract system admin tokens
#   Phase 2: Start orchestrators + video sidecars (with system tokens)
#   Phase 3: Mint peer tokens, establish BGP peering (A <-> B)
#
# Uses the Catalyst CLI (`bun apps/cli/src/index.ts`) for all token and
# orchestrator operations — same interface as a real deployment.
#
# Usage:
#   bash demo/video/init.sh
set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DOMAIN="somebiz.local.io"
COMPOSE_FILE="demo/video/docker-compose.yaml"
CLI="bun apps/cli/src/index.ts"

# Node A
NODE_A_ID="node-a.${DOMAIN}"
AUTH_A_URL="ws://localhost:5050/rpc"
AUTH_A_HEALTH="http://localhost:5050/health"
ORCH_A_URL="ws://localhost:3001/rpc"
ORCH_A_INTERNAL="ws://orch-a:3000/rpc"
ORCH_A_HEALTH="http://localhost:3001/health"
VIDEO_A_HEALTH="http://localhost:6000/health"

# Node B
NODE_B_ID="node-b.${DOMAIN}"
AUTH_B_URL="ws://localhost:5051/rpc"
AUTH_B_HEALTH="http://localhost:5051/health"
ORCH_B_URL="ws://localhost:3002/rpc"
ORCH_B_INTERNAL="ws://orch-b:3000/rpc"
ORCH_B_HEALTH="http://localhost:3002/health"
VIDEO_B_HEALTH="http://localhost:6001/health"

HEALTH_TIMEOUT=60
PEER_TIMEOUT=30

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

  echo "$output" | tail -1
}

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

compose_up() {
  docker compose -f "$COMPOSE_FILE" up -d "$@"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

echo
echo "============================================================"
echo "  Video Streaming 2-Node Demo — Bootstrap"
echo "============================================================"
echo

# ── Build all images upfront ───────────────────────────────────
log "Building all images..."
docker compose -f "$COMPOSE_FILE" build

# ── Phase 1: Auth services ──────────────────────────────────────

log "Phase 1: Starting auth services..."
compose_up auth-a auth-b

log "  Waiting for auth services..."
wait_for_health "$AUTH_A_HEALTH" "auth-a"
wait_for_health "$AUTH_B_HEALTH" "auth-b"

log "  Extracting system admin tokens..."
SYSTEM_TOKEN_A=$(extract_system_token auth-a)
SYSTEM_TOKEN_B=$(extract_system_token auth-b)
log "  auth-a: ${SYSTEM_TOKEN_A:0:20}..."
log "  auth-b: ${SYSTEM_TOKEN_B:0:20}..."

# ── Phase 2: Orchestrators + Video sidecars ──────────────────────

log "Phase 2: Starting orchestrators and video sidecars..."

CATALYST_SYSTEM_TOKEN_A="$SYSTEM_TOKEN_A" \
CATALYST_SYSTEM_TOKEN_B="$SYSTEM_TOKEN_B" \
  compose_up orch-a orch-b video-a video-b

log "  Waiting for orchestrators..."
wait_for_health "$ORCH_A_HEALTH" "orch-a"
wait_for_health "$ORCH_B_HEALTH" "orch-b"

log "  Waiting for video sidecars..."
wait_for_health "$VIDEO_A_HEALTH" "video-a"
wait_for_health "$VIDEO_B_HEALTH" "video-b"

# ── Phase 3: Peer tokens + BGP peering ──────────────────────────

log "Phase 3: Minting peer tokens and establishing BGP peering..."

log "  Minting peer tokens..."
PEER_TOKEN_A_FOR_B=$(mint_token "$AUTH_A_URL" "$SYSTEM_TOKEN_A" "$NODE_B_ID" "CATALYST::NODE")
log "    auth-a -> node-b: minted"
PEER_TOKEN_B_FOR_A=$(mint_token "$AUTH_B_URL" "$SYSTEM_TOKEN_B" "$NODE_A_ID" "CATALYST::NODE")
log "    auth-b -> node-a: minted"

log "  Establishing BGP peering (A <-> B)..."

log "    B registers peer A..."
create_peer "$ORCH_B_URL" "$SYSTEM_TOKEN_B" "$NODE_A_ID" "$ORCH_A_INTERNAL" "$DOMAIN" "$PEER_TOKEN_A_FOR_B"

log "    A registers peer B..."
create_peer "$ORCH_A_URL" "$SYSTEM_TOKEN_A" "$NODE_B_ID" "$ORCH_B_INTERNAL" "$DOMAIN" "$PEER_TOKEN_B_FOR_A"

log "  Waiting for peering handshakes..."
sleep 1
wait_for_peer "$ORCH_A_URL" "$SYSTEM_TOKEN_A" "$NODE_B_ID"
wait_for_peer "$ORCH_B_URL" "$SYSTEM_TOKEN_B" "$NODE_A_ID"
log "  BGP peering established: A <-> B"

# ── Done ─────────────────────────────────────────────────────────

echo
echo "============================================================"
echo "  Bootstrap Complete"
echo "============================================================"
echo
echo "  Topology:"
echo
echo "    [ Node A ] auth-a + orch-a + video-a (publisher)"
echo "         |"
echo "    [ Node B ] auth-b + orch-b + video-b (consumer)"
echo
echo "  Publish a test stream to Node A:"
echo "    ffmpeg -re -f lavfi -i testsrc=size=640x480:rate=30 \\"
echo "      -c:v libx264 -preset ultrafast -tune zerolatency \\"
echo "      -f rtsp rtsp://localhost:8554/cam-front"
echo
echo "  View on Node B:"
echo "    ffplay rtsp://localhost:8555/node-a.somebiz.local.io/cam-front"
echo
echo "  List streams:"
echo "    curl -s http://localhost:6000/video-stream/streams | jq ."
echo "    curl -s http://localhost:6001/video-stream/streams | jq ."
echo
