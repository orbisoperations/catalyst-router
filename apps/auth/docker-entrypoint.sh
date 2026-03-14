#!/bin/sh
set -e

# Fix volume ownership (Docker creates named volumes as root)
chown appuser:appgroup /data

# Drop privileges and exec the application
exec su-exec appuser "$@"
