#!/bin/sh
# Sync .env to Fly: secrets (staged, no restart) + env (fly.toml interpolation).
# Run from the project root (zeno-tak-adapter-v2) after fly launch.
#
# Usage:
#   ./scripts/fly-secrets-from-env.sh [options] [path-to-.env]
#
# Options:
#   --dry-run   Print what would be set/written without making changes
#   --deploy    Run fly deploy after staging secrets and updating fly.toml
#   --help      Show usage
#
# Environment:
#   FLY_APP     Override Fly app name (else uses fly.toml)
#
# -----------------------------------------------------------------------------
# Workflow
# -----------------------------------------------------------------------------
#   1. Parse .env and categorize variables as SECRETS or ENV
#   2. Stage secrets with `fly secrets import --stage` / `fly secrets set --stage`
#      (no machine restart triggered)
#   3. Write non-sensitive env vars into fly.toml [env] section
#      (preserves fly.toml-only vars like NODE_ENV)
#   4. Optionally run `fly deploy` to apply everything in a single deploy
#
# -----------------------------------------------------------------------------
# Secrets (sensitive; staged via fly secrets, encrypted at rest):
#   ZENOH_USER, ZENOH_PASSWORD     - Zenoh auth
#   TAK_TLS_PASSPHRASE             - TLS key passphrase
#   TAK_TLS_CERT, TAK_TLS_KEY, TAK_TLS_CA - TLS material (paths -> file content)
#
# Env (non-sensitive; written to fly.toml [env]):
#   ZENOH_ROUTER_URL, ZENOH_TOPIC_PREFIX, ZENOH_EXTERNAL_ROUTER_URL
#   TAK_HOST, TAK_PORT, TAK_CONNECTION_ID, TAK_RECONNECT_INTERVAL
#   TAK_HEARTBEAT_*, TAK_TLS_REJECT_UNAUTHORIZED
#   ZENOH_SUBSCRIPTIONS, PRODUCER_ENABLED, PRODUCER_TOPIC
#   TRANSFORMS_DIR, LOG_LEVEL
# -----------------------------------------------------------------------------
set -e

# -----------------------------------------------------------------------------
# Usage / Help
# -----------------------------------------------------------------------------
usage() {
    cat <<USAGE
Usage: $0 [options] [path-to-.env]

Sync .env to Fly.io:
  - Secrets are staged (no machine restart)
  - Env vars are written to fly.toml [env] section
  - A single 'fly deploy' applies everything

Options:
  --dry-run   Print what would be set/written without making changes
  --deploy    Run 'fly deploy' after staging secrets and updating fly.toml
  --help      Show this help message

Environment:
  FLY_APP     Override Fly app name (else uses fly.toml)

Examples:
  $0                          # Stage secrets + update fly.toml
  $0 --dry-run                # Preview without making changes
  $0 --deploy                 # Stage + update + deploy in one step
  $0 /path/to/.env            # Use specific .env file
  FLY_APP=my-app $0 --dry-run # Preview for specific app
USAGE
}

# -----------------------------------------------------------------------------
# Parse arguments
# -----------------------------------------------------------------------------
DRY_RUN=false
DO_DEPLOY=false
ENV_FILE=""

for arg in "$@"; do
    case "$arg" in
        --dry-run)
            DRY_RUN=true
            ;;
        --deploy)
            DO_DEPLOY=true
            ;;
        --help|-h)
            usage
            exit 0
            ;;
        -*)
            echo "ERROR: Unknown option: $arg" >&2
            usage >&2
            exit 1
            ;;
        *)
            ENV_FILE="$arg"
            ;;
    esac
done

SCRIPT_DIR="${0%/*}"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"
FLY_TOML="$ROOT_DIR/fly.toml"

# Names that must be treated as secrets (sensitive)
SECRET_NAMES="ZENOH_USER ZENOH_PASSWORD TAK_TLS_PASSPHRASE TAK_TLS_CERT TAK_TLS_KEY TAK_TLS_CA"
# TLS vars that may be file paths (we read file content instead of the path)
TLS_FILE_VARS="TAK_TLS_CERT TAK_TLS_KEY TAK_TLS_CA"

if [ ! -f "$ENV_FILE" ]; then
    echo "ERROR: .env file not found: $ENV_FILE" >&2
    echo "Run with --help for usage." >&2
    exit 1
fi

if [ ! -f "$FLY_TOML" ]; then
    echo "ERROR: fly.toml not found: $FLY_TOML" >&2
    echo "Run 'fly launch' first." >&2
    exit 1
fi

cd "$ROOT_DIR"

FLY_ARGS=""
if [ -n "$FLY_APP" ]; then
    FLY_ARGS="--app $FLY_APP"
fi

# -----------------------------------------------------------------------------
# Helper functions
# -----------------------------------------------------------------------------

# Filter .env: drop comments, empty lines; keep NAME=VALUE (single-line)
filter_env() {
    grep -v '^#' "$ENV_FILE" \
        | grep -v '^[[:space:]]*$' \
        | sed 's/\r$//;s/^[[:space:]]*//;s/[[:space:]]*$//' \
        | grep -E '^[A-Za-z_][A-Za-z0-9_]*=' || true
}

# Returns 0 if $1 is in space-separated list $2
is_in_list() {
    _name="$1"; _list="$2"
    for _x in $_list; do
        [ "$_x" = "$_name" ] && return 0
    done
    return 1
}

# Extract existing fly.toml-only vars from [env] section (vars not in .env).
# These are preserved during interpolation (e.g. NODE_ENV=production).
# Outputs lines like: NODE_ENV=production
get_flytoml_only_vars() {
    _env_names=""
    _filtered="$(filter_env)"
    # Collect all .env var names
    echo "$_filtered" | while IFS= read -r _line; do
        [ -z "$_line" ] && continue
        echo "${_line%%=*}"
    done > /tmp/_env_names_$$

    # Parse [env] section from fly.toml
    _in_env=false
    while IFS= read -r _line; do
        case "$_line" in
            "[env]"*) _in_env=true; continue ;;
            "["*|"[["*) _in_env=false; continue ;;
        esac
        if [ "$_in_env" = true ]; then
            # Skip empty/comment lines
            _trimmed="$(echo "$_line" | sed 's/^[[:space:]]*//')"
            [ -z "$_trimmed" ] && continue
            echo "$_trimmed" | grep -qE '^#' && continue
            # Extract KEY from "KEY = 'value'" TOML format
            _key="$(echo "$_trimmed" | sed "s/[[:space:]]*=.*//")"
            # Check if this key exists in .env
            if ! grep -qx "$_key" /tmp/_env_names_$$; then
                # Convert TOML "KEY = 'value'" to "KEY=value"
                _val="$(echo "$_trimmed" | sed "s/^[^=]*=[[:space:]]*//" | sed "s/^'//;s/'$//")"
                echo "${_key}=${_val}"
            fi
        fi
    done < "$FLY_TOML"

    rm -f /tmp/_env_names_$$
}

# -----------------------------------------------------------------------------
# Parse .env and categorize variables
# -----------------------------------------------------------------------------

# Secrets: sensitive vars (excluding TLS file vars which are handled separately)
SECRET_LINES=""
TLS_CERT_VAL="" TLS_KEY_VAL="" TLS_CA_VAL=""
while IFS= read -r line; do
    [ -z "$line" ] && continue
    name="${line%%=*}"
    value="${line#*=}"
    if is_in_list "$name" "$SECRET_NAMES"; then
        if is_in_list "$name" "$TLS_FILE_VARS"; then
            case "$name" in
                TAK_TLS_CERT) TLS_CERT_VAL="$value" ;;
                TAK_TLS_KEY)  TLS_KEY_VAL="$value"  ;;
                TAK_TLS_CA)   TLS_CA_VAL="$value"   ;;
            esac
        else
            SECRET_LINES="${SECRET_LINES}${line}\n"
        fi
    fi
done <<EOF
$(filter_env)
EOF

# Env: non-sensitive vars (will go into fly.toml [env])
ENV_LINES=""
while IFS= read -r line; do
    [ -z "$line" ] && continue
    name="${line%%=*}"
    if ! is_in_list "$name" "$SECRET_NAMES"; then
        ENV_LINES="${ENV_LINES}${line}\n"
    fi
done <<EOF
$(filter_env)
EOF

# Collect fly.toml-only vars to preserve
FLYTOML_ONLY="$(get_flytoml_only_vars)"

# -----------------------------------------------------------------------------
# Build the new [env] block for fly.toml
# -----------------------------------------------------------------------------
build_env_block() {
    echo "[env]"
    # Env vars from .env (non-sensitive)
    printf '%b' "$ENV_LINES" | while IFS= read -r line; do
        [ -z "$line" ] && continue
        _key="${line%%=*}"
        _val="${line#*=}"
        echo "  $_key = '$_val'"
    done
    # Preserved fly.toml-only vars (e.g. NODE_ENV)
    echo "$FLYTOML_ONLY" | while IFS= read -r line; do
        [ -z "$line" ] && continue
        _key="${line%%=*}"
        _val="${line#*=}"
        echo "  $_key = '$_val'"
    done
}

# -----------------------------------------------------------------------------
# Print summary
# -----------------------------------------------------------------------------
print_summary() {
    echo ""
    echo "=== SECRETS (staged, no restart) ==="
    # Non-TLS secrets (redacted)
    printf '%b' "$SECRET_LINES" | while IFS= read -r line; do
        [ -z "$line" ] && continue
        echo "  ${line%%=*}=<redacted>"
    done
    # TLS secrets (show source)
    for _pair in "TAK_TLS_CERT:$TLS_CERT_VAL" "TAK_TLS_KEY:$TLS_KEY_VAL" "TAK_TLS_CA:$TLS_CA_VAL"; do
        _n="${_pair%%:*}"
        _v="${_pair#*:}"
        [ -z "$_v" ] && continue
        if [ -f "$_v" ]; then
            echo "  $_n=<from file: $_v>"
        else
            echo "  $_n=<inline PEM or path not found>"
        fi
    done

    echo ""
    echo "=== fly.toml [env] (non-sensitive) ==="
    build_env_block | while IFS= read -r line; do
        echo "  $line"
    done
    echo ""
}

# -----------------------------------------------------------------------------
# Update fly.toml [env] section in-place
# -----------------------------------------------------------------------------
update_fly_toml() {
    _new_env_block="$(build_env_block)"
    _tmp="$FLY_TOML.tmp.$$"

    _in_env=false
    _env_written=false
    while IFS= read -r line; do
        case "$line" in
            "[env]"*)
                _in_env=true
                echo "$_new_env_block" >> "$_tmp"
                _env_written=true
                continue
                ;;
            "["*|"[["*)
                if [ "$_in_env" = true ]; then
                    _in_env=false
                    # Add blank line before next section
                    echo "" >> "$_tmp"
                fi
                echo "$line" >> "$_tmp"
                continue
                ;;
        esac
        if [ "$_in_env" = true ]; then
            # Skip old [env] content (we already wrote the new block)
            continue
        fi
        echo "$line" >> "$_tmp"
    done < "$FLY_TOML"

    mv "$_tmp" "$FLY_TOML"
}

# -----------------------------------------------------------------------------
# Stage TLS secret from file or inline value (--stage, no restart)
# -----------------------------------------------------------------------------
stage_tls_secret() {
    _var="$1"
    _val="$2"
    [ -z "$_val" ] && return
    if [ -f "$_val" ]; then
        echo "  Staging $_var from file: $_val"
        fly secrets set $FLY_ARGS "$_var=$(cat "$_val")" --stage
    else
        echo "  Staging $_var (inline PEM or path not found)"
        fly secrets set $FLY_ARGS "$_var=$_val" --stage
    fi
}

# =============================================================================
# Main
# =============================================================================

if [ "$DRY_RUN" = true ]; then
    echo "=== DRY RUN ==="
    echo "Source: $ENV_FILE"
    echo "Target: $FLY_TOML"
    echo "Fly app: ${FLY_APP:-<from fly.toml>}"
    print_summary
    echo "(No changes made. Run without --dry-run to apply.)"
    exit 0
fi

echo "Syncing .env to Fly app${FLY_APP:+ ($FLY_APP)}..."
echo "Source: $ENV_FILE"
echo ""

# --- Step 1: Stage secrets (no restart) ---
echo "--- Step 1: Stage secrets (fly secrets --stage) ---"
if [ -n "$SECRET_LINES" ]; then
    echo "  Staging sensitive secrets (ZENOH_USER, ZENOH_PASSWORD, TAK_TLS_PASSPHRASE)..."
    printf '%b' "$SECRET_LINES" | fly secrets import $FLY_ARGS --stage
else
    echo "  No sensitive secret vars in $ENV_FILE"
fi

[ -n "$TLS_CERT_VAL" ] && stage_tls_secret "TAK_TLS_CERT" "$TLS_CERT_VAL"
[ -n "$TLS_KEY_VAL" ]  && stage_tls_secret "TAK_TLS_KEY"  "$TLS_KEY_VAL"
[ -n "$TLS_CA_VAL" ]   && stage_tls_secret "TAK_TLS_CA"   "$TLS_CA_VAL"

echo ""

# --- Step 2: Update fly.toml [env] ---
echo "--- Step 2: Update fly.toml [env] ---"
update_fly_toml
echo "  Updated $FLY_TOML [env] with non-sensitive vars."
echo "  Preserved fly.toml-only vars: $(echo "$FLYTOML_ONLY" | while IFS= read -r l; do [ -z "$l" ] && continue; printf '%s ' "${l%%=*}"; done)"

echo ""

# --- Step 3: Deploy (optional) ---
if [ "$DO_DEPLOY" = true ]; then
    echo "--- Step 3: Deploying (fly deploy) ---"
    fly deploy $FLY_ARGS
    echo ""
    echo "Deploy complete. Staged secrets and fly.toml [env] are now live."
else
    echo "--- Next step ---"
    echo "Secrets are staged and fly.toml is updated."
    echo "Run 'fly deploy${FLY_APP:+ --app $FLY_APP}' to apply everything in a single deploy."
fi
