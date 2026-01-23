#!/bin/bash

# Attempt to detect the Podman socket path on the host
if [[ "$OSTYPE" == "darwin"* ]]; then
    # On Mac, we need the host-side socket linked to the VM
    MACHINE_NAME=$(podman machine list --format '{{.Name}} {{.Default}}' | grep 'true' | cut -d' ' -f1)
    if [ -z "$MACHINE_NAME" ]; then
        # Fallback to the first machine if none is marked default but one exists
        MACHINE_NAME=$(podman machine list --format '{{.Name}}' | head -n 1)
    fi
    
    if [ -n "$MACHINE_NAME" ]; then
        PODMAN_SOCKET=$(podman machine inspect "$MACHINE_NAME" --format '{{.ConnectionInfo.PodmanSocket.Path}}' 2>/dev/null)
    fi
fi

# Fallback to podman info if Mac detection failed or not on Mac
if [ -z "$PODMAN_SOCKET" ] || [[ ! "$PODMAN_SOCKET" == /* ]]; then
    PODMAN_SOCKET=$(podman info --format '{{.Host.RemoteSocket.Path}}' 2>/dev/null | sed 's|^unix://||')
fi

# Final fallback for known paths if detection resulted in an internal VM path (which starts with /run)
if [[ "$PODMAN_SOCKET" == /run/* ]] && [[ "$OSTYPE" == "darwin"* ]]; then
    if [ -S "$HOME/.local/share/containers/podman/machine/qemu/podman.sock" ]; then
        PODMAN_SOCKET="$HOME/.local/share/containers/podman/machine/qemu/podman.sock"
    fi
fi

if [ -z "$PODMAN_SOCKET" ]; then
    echo "Warning: Podman socket not detected. Container tests may skip."
else
    echo "Podman socket detected: $PODMAN_SOCKET"
    export DOCKER_HOST="unix://$PODMAN_SOCKET"
fi

# Required environment variables for testcontainers with Podman
export TESTCONTAINERS_RYUK_DISABLED=true
export TESTCONTAINERS_CHECKS_DISABLE=true

# Execute bun test with any passed arguments
exec bun test "$@"
