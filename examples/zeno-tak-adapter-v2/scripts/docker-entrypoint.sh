#!/bin/sh
set -e

BRIDGE_CONFIG_TEMPLATE="/app/zenoh-bridge-config.json5"
RUNTIME_CONFIG="/tmp/zenoh-runtime-config.json5"
STANDALONE_CONFIG="/app/zenoh-test-config.json5"

# Generate runtime config by substituting environment variables
generate_bridge_config() {
    if [ -z "$ZENOH_EXTERNAL_ROUTER_URL" ]; then
        echo "ERROR: ZENOH_EXTERNAL_ROUTER_URL is required for bridge mode"
        exit 1
    fi

    echo "Generating Zenoh bridge config..."
    echo "  External router: $ZENOH_EXTERNAL_ROUTER_URL"

    # Substitute the placeholder with the actual external router URL
    sed "s|__ZENOH_EXTERNAL_ROUTER_URL__|${ZENOH_EXTERNAL_ROUTER_URL}|g" \
        "$BRIDGE_CONFIG_TEMPLATE" > "$RUNTIME_CONFIG"

    echo "Bridge config generated at $RUNTIME_CONFIG"
}

# Start Zenoh in bridge/peer mode connecting to external router
start_zenoh_bridge() {
    generate_bridge_config
    echo "Starting Zenoh bridge (peer mode)..."
    zenohd --config "$RUNTIME_CONFIG" &
    ZENOHD_PID=$!
    echo "Zenoh bridge started with PID $ZENOHD_PID"
}

# Fallback: Start standalone Zenoh router (when ZENOH_EXTERNAL_ROUTER_URL unset)
start_zenoh_standalone() {
    echo "Starting Zenoh in standalone router mode..."
    if [ -n "$ZENOH_CONFIG_PATH" ] && [ -f "$ZENOH_CONFIG_PATH" ]; then
        zenohd --config "$ZENOH_CONFIG_PATH" &
    elif [ -f "$STANDALONE_CONFIG" ]; then
        zenohd --config "$STANDALONE_CONFIG" &
    else
        zenohd &
    fi
    ZENOHD_PID=$!
    echo "Zenoh router started with PID $ZENOHD_PID"
}

# Main: Determine which mode to run
if [ -n "$ZENOH_EXTERNAL_ROUTER_URL" ]; then
    start_zenoh_bridge
else
    echo "WARNING: ZENOH_EXTERNAL_ROUTER_URL not set, falling back to standalone router mode"
    start_zenoh_standalone
fi

# Wait for in-container zenohd to become ready (REST plugin on port 8000 if available,
# otherwise just wait for the remote_api WebSocket on port 10000).
echo "Waiting for in-container zenohd to start..."
MAX_WAIT=15
WAITED=0
while [ "$WAITED" -lt "$MAX_WAIT" ]; do
    # Check if zenohd is still running
    if ! kill -0 "$ZENOHD_PID" 2>/dev/null; then
        echo "ERROR: zenohd (PID $ZENOHD_PID) exited prematurely"
        exit 1
    fi
    # Try the REST endpoint first (port 8000), fall back to checking WS port
    if curl -sf http://localhost:8000/@/router/local > /dev/null 2>&1; then
        echo "Zenohd is ready (REST check passed after ${WAITED}s)"
        break
    fi
    WAITED=$((WAITED + 1))
    sleep 1
done
if [ "$WAITED" -ge "$MAX_WAIT" ]; then
    echo "WARNING: Zenohd did not respond to REST check within ${MAX_WAIT}s, proceeding anyway..."
fi

# The adapter always talks to the in-container zenohd via WebSocket (remote_api plugin).
export ZENOH_ROUTER_URL="${ZENOH_ROUTER_URL:-ws://localhost:10000}"
echo "Adapter will connect to Zenoh at: $ZENOH_ROUTER_URL"

# Run the application (receive signals as PID 1)
exec node dist/index.js
