#!/bin/bash
set -e

# Detect Podman socket
if [ -z "$DOCKER_HOST" ]; then
    PODMAN_SOCK="/var/folders/q5/zpx662k93sgb7srpmbb4s9xm0000gn/T/podman/podman-machine-default-api.sock"
    if [ -S "$PODMAN_SOCK" ]; then
        echo "Podman socket detected: $PODMAN_SOCK"
        export DOCKER_HOST="unix://$PODMAN_SOCK"
    else
        echo "Warning: Podman socket not found at $PODMAN_SOCK"
    fi
fi

# Build shared image once to avoid race conditions
echo "Ensuring Orchestrator base image exists..."
podman build -f packages/orchestrator/Dockerfile -t localhost/catalyst-node:next-topology-e2e .

# Run each test file sequentially
FAILED=0
TEST_FILES=(
    "packages/orchestrator/src/next/peering.orchestrator.topology.container.test.ts"
    "packages/orchestrator/src/next/transit.orchestrator.topology.container.test.ts"
    "packages/orchestrator/src/next/orchestrator.test.ts"
    "packages/orchestrator/src/next/orchestrator.gateway.container.test.ts"
)

for test in "${TEST_FILES[@]}"; do
    echo "Running test: $test"
    # Clean up before each test file
    podman ps -aq | xargs podman rm -f || true
    
    if ! bun test "$test"; then
        echo "Test failed: $test"
        FAILED=1
    fi
done

if [ $FAILED -ne 0 ]; then
    echo "One or more tests failed."
    exit 1
else
    echo "All container tests passed!"
    exit 0
fi
