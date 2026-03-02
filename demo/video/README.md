# Video Streaming 2-Node Demo

Two Catalyst nodes peered over a mesh network, propagating media routes via
iBGP. Node A publishes a stream; Node B discovers and relays it automatically.

## Prerequisites

- Docker & Docker Compose
- [Bun](https://bun.sh) (the init script uses the Catalyst CLI via `bun`)
- `ffmpeg` / `ffplay` for publishing and viewing test streams

## Quick Start

```bash
# From the repo root:
bash demo/video/init.sh
```

The script builds all images, starts services in dependency order, mints auth
tokens, and establishes BGP peering between the two nodes. It takes about 60
seconds on first run (subsequent runs use cached layers).

## Architecture

```
  ┌─────────── Node A (Publisher) ────────────┐
  │  auth-a (:5050)                           │
  │  orch-a (:3001)                           │
  │  video-a (:6000) + MediaMTX (:8554 RTSP)  │
  └───────────────────┬───────────────────────┘
                      │  mesh network (iBGP)
  ┌───────────────────┴───────────────────────┐
  │  auth-b (:5051)                           │
  │  orch-b (:3002)                           │
  │  video-b (:6001) + MediaMTX (:8555 RTSP)  │
  └─────────── Node B (Consumer) ─────────────┘
```

Each node runs three services:

| Service          | Role                                                                   |
| ---------------- | ---------------------------------------------------------------------- |
| **auth**         | JWT token minting & validation (in-memory SQLite)                      |
| **orchestrator** | Control plane — peering, route propagation, video sidecar coordination |
| **video**        | MediaMTX process manager + stream state tracking                       |

### Bootstrap Phases

1. **Auth services** start first; the script extracts auto-generated system
   admin tokens from their logs.
2. **Orchestrators + video sidecars** start with those tokens injected as env
   vars.
3. **Peer tokens** are minted and BGP peering is established (A ↔ B).

## Testing Streams

### Publish a test pattern to Node A

```bash
ffmpeg -re -f lavfi -i testsrc=size=640x480:rate=30 \
  -c:v libx264 -preset ultrafast -tune zerolatency \
  -f rtsp rtsp://localhost:8554/cam-front
```

This publishes an RTSP stream named `cam-front` to Node A's MediaMTX.

### Watch the stream locally on Node A

```bash
ffplay rtsp://localhost:8554/cam-front
```

### Watch the stream on Node B (cross-node relay)

```bash
ffplay rtsp://localhost:8555/node-a.somebiz.local.io/cam-front
```

Node B discovers the stream via BGP route propagation and pulls it from
Node A automatically. The path format is `<origin-node-id>/<stream-name>`.

### Stream with a real camera (macOS)

```bash
ffmpeg -f avfoundation -framerate 30 -i "0" \
  -c:v libx264 -preset ultrafast -tune zerolatency \
  -f rtsp rtsp://localhost:8554/webcam
```

### HLS playback (browser)

Node A: `http://localhost:8878/cam-front`
Node B: `http://localhost:8898/node-a.somebiz.local.io/cam-front`

## Inspecting State

### List active streams

```bash
# Node A
curl -s http://localhost:6000/video-stream/streams | jq .

# Node B
curl -s http://localhost:6001/video-stream/streams | jq .
```

### Health checks

```bash
curl -s http://localhost:6000/health | jq .
curl -s http://localhost:6001/health | jq .
```

### Container logs

```bash
# All services
docker compose -f demo/video/docker-compose.yaml logs -f

# Single service
docker compose -f demo/video/docker-compose.yaml logs -f video-a
```

### Peer status (via CLI)

```bash
# Extract a system token first
TOKEN=$(docker compose -f demo/video/docker-compose.yaml logs auth-a 2>/dev/null \
  | grep -o 'System Admin Token minted: [^ ]*' | head -1 \
  | sed 's/System Admin Token minted: //')

# List peers on Node A
bun apps/cli/src/index.ts \
  --orchestrator-url ws://localhost:3001/rpc \
  --token "$TOKEN" \
  node peer list
```

## Port Reference

| Port | Service          | Protocol  |
| ---- | ---------------- | --------- |
| 5050 | auth-a           | HTTP      |
| 5051 | auth-b           | HTTP      |
| 3001 | orch-a           | HTTP + WS |
| 3002 | orch-b           | HTTP + WS |
| 6000 | video-a API      | HTTP      |
| 6001 | video-b API      | HTTP      |
| 8554 | video-a MediaMTX | RTSP      |
| 8555 | video-b MediaMTX | RTSP      |
| 8878 | video-a MediaMTX | HLS       |
| 8898 | video-b MediaMTX | HLS       |
| 8879 | video-a MediaMTX | WebRTC    |
| 8899 | video-b MediaMTX | WebRTC    |
| 8890 | video-a MediaMTX | SRT       |
| 8891 | video-b MediaMTX | SRT       |

> Some host ports are remapped from the container defaults (8888, 8889) to
> avoid conflicts with common local services (OTEL collectors, InfluxDB, etc).

## Teardown

```bash
docker compose -f demo/video/docker-compose.yaml down
```

## Troubleshooting

**Port already in use** — Check for conflicting containers or services:

```bash
lsof -i :<port> -P -n | grep LISTEN
```

Adjust the host port mapping in `docker-compose.yaml` if needed.

**MediaMTX crashes on startup** — Check the video container logs for the
underlying error:

```bash
docker compose -f demo/video/docker-compose.yaml logs video-a
```

MediaMTX writes its errors to stderr, which is forwarded to the container log.

**Peering not connecting** — Ensure both orchestrators are healthy before the
init script reaches Phase 3. You can re-run peering manually:

```bash
bash demo/video/init.sh
```

The script is idempotent — it will rebuild containers and re-establish peering.
