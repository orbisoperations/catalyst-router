#!/usr/bin/env bash
set -euo pipefail

# quickstart.sh — one-command dev setup for a Catalyst RPi image.
#
# Detects your current WiFi, generates an SSH key, optionally sets up a
# Cloudflare Tunnel, generates the config, compiles the binary, and builds
# the image. Stops right before flashing.
#
# Usage:
#   ./builds/rpi/quickstart.sh
#   ./builds/rpi/quickstart.sh --no-tunnel
#   ./builds/rpi/quickstart.sh --domain example.com --tunnel-name edge-01
#   ./builds/rpi/quickstart.sh --hostname my-node --password secret

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="$REPO_ROOT/dist/rpi"

# ─── Defaults (edit these) ────────────────────────────────────────────────────
PASSWORD="Catalyst1!"
PI_HOSTNAME="catalyst-node"
MODE="native"
IMAGE_NAME="catalyst-node-image"
WIFI_COUNTRY="US"
SSH_KEY="$HOME/.ssh/catalyst-deploy"
NO_TUNNEL=false
DRY_RUN=false
CF_DOMAIN=""
TUNNEL_NAME=""

# ─── Parse args ───────────────────────────────────────────────────────────────
usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

One-command dev setup: detect WiFi, generate SSH key, set up Cloudflare
Tunnel, generate config, compile binary, and build the RPi image.

Options:
  --password <pass>        Login password (default: Catalyst1!)
  --hostname <name>        Pi hostname (default: catalyst-node)
  --mode <native|docker>   Deployment mode (default: native)
  --wifi-country <code>    WiFi country code (default: US)
  --domain <domain>        Cloudflare domain for tunnel DNS route
  --tunnel-name <name>     Cloudflare Tunnel name (default: same as hostname)
  --no-tunnel              Skip Cloudflare Tunnel setup
  --dry-run                Generate config only, skip build
  -h, --help               Show this help

Examples:
  # Minimal — detect WiFi, skip tunnel
  $(basename "$0") --no-tunnel

  # Full — with Cloudflare Tunnel
  $(basename "$0") --domain example.com

  # Custom hostname and password
  $(basename "$0") --hostname edge-01 --password mypass --domain example.com
EOF
  exit 0
}

needs_arg() { if [[ $# -lt 2 || "$2" == --* ]]; then err "$1 requires a value"; fi; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --password)     needs_arg "$@"; PASSWORD="$2"; shift 2 ;;
    --hostname)     needs_arg "$@"; PI_HOSTNAME="$2"; shift 2 ;;
    --mode)         needs_arg "$@"; MODE="$2"; shift 2 ;;
    --wifi-country) needs_arg "$@"; WIFI_COUNTRY="$2"; shift 2 ;;
    --domain)       needs_arg "$@"; CF_DOMAIN="$2"; shift 2 ;;
    --tunnel-name)  needs_arg "$@"; TUNNEL_NAME="$2"; shift 2 ;;
    --no-tunnel)    NO_TUNNEL=true; shift ;;
    --dry-run)      DRY_RUN=true; shift ;;
    -h|--help)      usage ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

TUNNEL_NAME="${TUNNEL_NAME:-$PI_HOSTNAME}"

if [[ "$MODE" != "native" && "$MODE" != "docker" ]]; then
  echo "Invalid mode: $MODE (must be 'native' or 'docker')" >&2; exit 1
fi

# ─── Helpers ──────────────────────────────────────────────────────────────────
info()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m  ⚠\033[0m  %s\n' "$*"; }
err()   { printf '\033[1;31m  ✗\033[0m  %s\n' "$*" >&2; exit 1; }
ok()    { printf '\033[1;32m  ✓\033[0m  %s\n' "$*"; }

# ─── 0. Preflight ────────────────────────────────────────────────────────────
if [[ "$DRY_RUN" == false ]]; then
  if ! command -v docker &>/dev/null; then
    err "Docker is required to build the image. Install Docker Desktop first."
  fi
  if ! docker info &>/dev/null; then
    err "Docker is not running. Start Docker Desktop first."
  fi
  ok "Docker available"
fi

if ! command -v bun &>/dev/null; then
  err "bun is required. Install it: https://bun.sh"
fi

# ─── 1. Detect WiFi ──────────────────────────────────────────────────────────
info "Detecting WiFi..."

if [[ "$(uname)" == "Darwin" ]]; then
  WIFI_IF=$(networksetup -listallhardwareports | awk '/Wi-Fi|AirPort/{getline; print $2}')
  WIFI_IF="${WIFI_IF:-en0}"
  # ipconfig works on modern macOS where networksetup may report "not associated"
  SSID=$(ipconfig getsummary "$WIFI_IF" 2>/dev/null | awk -F' : ' '/^  SSID /{print $2}')
  if [[ -z "$SSID" ]]; then
    # Fallback to networksetup for older macOS
    SSID=$(networksetup -getairportnetwork "$WIFI_IF" 2>/dev/null | sed 's/^Current Wi-Fi Network: //')
  fi
  if [[ -z "$SSID" || "$SSID" == *"not associated"* ]]; then
    err "Not connected to WiFi. Connect to a network first."
  fi
  # TODO: read WiFi password from macOS Keychain
  # WIFI_PASS=$(security find-generic-password -D "AirPort network password" -a "$SSID" -w 2>/dev/null || true)
  # if [[ -z "$WIFI_PASS" ]]; then
  #   WIFI_PASS=$(security find-generic-password -ga "$SSID" 2>&1 | grep "password:" | sed 's/^password: "\(.*\)"$/\1/' || true)
  # fi
  WIFI_PASS=""
else
  # Linux — try nmcli
  SSID=$(nmcli -t -f active,ssid dev wifi | grep '^yes' | sed 's/^yes://')
  if [[ -z "$SSID" ]]; then
    err "Not connected to WiFi."
  fi
  WIFI_PASS=$(nmcli -s -g 802-11-wireless-security.psk connection show "$SSID" 2>/dev/null || true)
fi

ok "WiFi: $SSID"

# ─── 2. SSH Key ──────────────────────────────────────────────────────────────
info "Checking SSH key..."

if [[ -f "$SSH_KEY" ]]; then
  ok "Using existing key: $SSH_KEY"
else
  SSH_DIR="$(dirname "$SSH_KEY")"
  if [[ ! -d "$SSH_DIR" ]]; then
    mkdir -p "$SSH_DIR"
    chmod 700 "$SSH_DIR"
    ok "Created $SSH_DIR"
  fi
  ssh-keygen -t ed25519 -f "$SSH_KEY" -C "catalyst-deploy" -N ""
  ok "Generated key: $SSH_KEY"
fi

# ─── 3. Cloudflare Tunnel (optional) ─────────────────────────────────────────
CF_TOKEN=""

if [[ "$NO_TUNNEL" == false ]]; then
  info "Setting up Cloudflare Tunnel..."

  if ! command -v cloudflared &>/dev/null; then
    info "Installing cloudflared..."
    if [[ "$(uname)" == "Darwin" ]]; then
      brew install cloudflared
    else
      err "cloudflared not found. Install it: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
    fi
  fi
  ok "cloudflared installed"

  # Authenticate if needed
  if [[ ! -f "$HOME/.cloudflared/cert.pem" ]]; then
    info "Authenticating with Cloudflare (opens browser)..."
    cloudflared tunnel login
  fi
  ok "Authenticated"

  # Determine the public hostname for the tunnel
  if [[ -z "$CF_DOMAIN" ]]; then
    err "Cloudflare Tunnel requires --domain <your-domain>. Use --no-tunnel to skip."
  fi
  CF_HOSTNAME="ssh-${TUNNEL_NAME}.${CF_DOMAIN}"

  # Create tunnel (ignore error if it already exists)
  if cloudflared tunnel info "$TUNNEL_NAME" &>/dev/null; then
    ok "Tunnel '$TUNNEL_NAME' already exists"
  else
    info "Creating tunnel: $TUNNEL_NAME"
    cloudflared tunnel create "$TUNNEL_NAME"
    ok "Tunnel created"
  fi

  # Route DNS (ignore error if route already exists)
  info "Routing $CF_HOSTNAME → tunnel"
  cloudflared tunnel route dns "$TUNNEL_NAME" "$CF_HOSTNAME" 2>/dev/null || true
  ok "DNS route: $CF_HOSTNAME"

  # Get token
  CF_TOKEN=$(cloudflared tunnel token "$TUNNEL_NAME")
  ok "Got tunnel token"
fi

# ─── 4. Generate config ──────────────────────────────────────────────────────
info "Generating config..."

# Pass secrets via env vars so they don't appear in `ps aux`
export CATALYST_PASSWORD="$PASSWORD"
if [[ -n "$WIFI_PASS" ]]; then
  export CATALYST_WIFI_PASSWORD="$WIFI_PASS"
fi
if [[ -n "$CF_TOKEN" ]]; then
  export CATALYST_CF_TUNNEL_TOKEN="$CF_TOKEN"
fi

CONFIG_ARGS=(
  --non-interactive
  --mode "$MODE"
  --hostname "$PI_HOSTNAME"
  --wifi-ssid "$SSID"
  --wifi-country "$WIFI_COUNTRY"
  --ssh-pubkey-file "${SSH_KEY}.pub"
  -o "$OUT_DIR"
)

if [[ -z "$CF_TOKEN" ]]; then
  CONFIG_ARGS+=(--no-cloudflared)
fi

if [[ "$DRY_RUN" == true ]]; then
  CONFIG_ARGS+=(--dry-run)
fi

(cd "$REPO_ROOT" && bun run apps/rpi-config/src/index.ts "${CONFIG_ARGS[@]}")

unset CATALYST_PASSWORD CATALYST_WIFI_PASSWORD CATALYST_CF_TUNNEL_TOKEN

if [[ "$DRY_RUN" == true ]]; then
  ok "Dry run complete — config printed above, nothing built."
  exit 0
fi

ok "Config written to $OUT_DIR/config.yaml"

# ─── 5. Build binary (native mode only) ──────────────────────────────────────
if [[ "$MODE" == "native" ]]; then
  info "Compiling catalyst-node binary for ARM64..."
  (cd "$REPO_ROOT" && bun build --compile --target=bun-linux-arm64 \
    --outfile "$OUT_DIR/bin/catalyst-node" apps/node/src/index.ts)
  ok "Binary: $OUT_DIR/bin/catalyst-node"
fi

# ─── 6. Build image ──────────────────────────────────────────────────────────
info "Building RPi image (this runs in Docker)..."
"$SCRIPT_DIR/build-docker.sh" --source-dir "$OUT_DIR" "$OUT_DIR/config.yaml"

# ─── Done ─────────────────────────────────────────────────────────────────────
IMG_PATH="$OUT_DIR/build/image-${IMAGE_NAME}/${IMAGE_NAME}.img"

echo ""
info "Image ready! Next steps:"
echo ""
echo "  1. Flash the SD card:"
if [[ "$(uname)" == "Darwin" ]]; then
  echo "     diskutil list                    # find your SD card"
  echo "     diskutil unmountDisk /dev/diskN"
  echo "     sudo dd if=$IMG_PATH \\"
  echo "       of=/dev/rdiskN bs=4m status=progress"
else
  echo "     lsblk                            # find your SD card"
  echo "     sudo dd if=$IMG_PATH \\"
  echo "       of=/dev/sdX bs=4M status=progress"
fi
echo ""
echo "  Or use Raspberry Pi Imager → 'Use custom' → select the .img file."
echo ""
echo "  2. Boot the Pi, then SSH in:"
echo "     ssh -i $SSH_KEY catalyst@$PI_HOSTNAME.local"
if [[ -n "$CF_TOKEN" ]]; then
  echo ""
  echo "  Or via Cloudflare Tunnel:"
  echo "     ssh -o ProxyCommand=\"cloudflared access ssh --hostname %h\" \\"
  echo "       -i $SSH_KEY catalyst@$CF_HOSTNAME"
fi
echo ""
