FROM oven/bun:1.3.9-alpine AS builder
WORKDIR /app

# Install dependencies
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

# Copy source, build script, and Zenoh configs
COPY src ./src
COPY tsconfig.json build.mjs ./

# Build the application (requires src/index.ts)
RUN bun run build

FROM oven/bun:1.3.9 AS production

WORKDIR /app

# Zenoh version must match across zenohd and the remote-api plugin
ARG ZENOH_VERSION=1.7.2

# Install Zenoh router (zenohd) from the Eclipse Debian repo
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gnupg \
    unzip \
    && curl -fsSL https://download.eclipse.org/zenoh/debian-repo/zenoh-public-key | gpg --dearmor --yes --output /etc/apt/keyrings/zenoh-public-key.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/zenoh-public-key.gpg] https://download.eclipse.org/zenoh/debian-repo/ /" | tee /etc/apt/sources.list.d/zenoh.list > /dev/null \
    && apt-get update \
    && apt-get install -y --no-install-recommends zenoh \
    && rm -rf /var/lib/apt/lists/*

# Install zenoh-plugin-remote-api (not in the Debian repo, downloaded separately).
# This plugin gives zenohd a WebSocket endpoint that zenoh-ts can connect to.
# The Debian variant ships .deb packages inside the zip, so we extract and dpkg -i them.
RUN ARCH=$(dpkg --print-architecture) && \
    case "$ARCH" in \
    arm64|aarch64) ZENOH_ARCH="aarch64" ;; \
    amd64|x86_64)  ZENOH_ARCH="x86_64"  ;; \
    *)             echo "Unsupported arch: $ARCH" && exit 1 ;; \
    esac && \
    echo "Downloading zenoh-plugin-remote-api ${ZENOH_VERSION} for ${ZENOH_ARCH}-unknown-linux-gnu (debian)..." && \
    curl -fsSL -o /tmp/zenoh-ts.zip \
    "https://download.eclipse.org/zenoh/zenoh-plugin-remote-api/${ZENOH_VERSION}/zenoh-ts-${ZENOH_VERSION}-${ZENOH_ARCH}-unknown-linux-gnu-debian.zip" && \
    unzip -o /tmp/zenoh-ts.zip -d /tmp/zenoh-ts && \
    dpkg -i /tmp/zenoh-ts/zenoh-plugin-remote-api_*.deb && \
    rm -rf /tmp/zenoh-ts /tmp/zenoh-ts.zip && \
    echo "remote-api plugin installed:" && \
    find /usr/lib -name '*remote_api*' -ls


COPY --from=builder /app/dist /app/dist

COPY build/zenoh-bridge-config.json5 build/zenoh-test-config.json5 ./
COPY scripts/docker-entrypoint.sh ./scripts/

RUN chmod +x ./scripts/docker-entrypoint.sh

# Environment variables
ENV NODE_ENV=production
# ZENOH_EXTERNAL_ROUTER_URL - Required for bridge mode (e.g. tcp/host.docker.internal:7447).
#   When set, in-container zenohd runs in peer mode connecting to the external router via TCP.
#   When unset, zenohd runs in standalone router mode.
# ZENOH_ROUTER_URL - Defaults to ws://localhost:10000 in the entrypoint (the in-container zenohd WS endpoint).

# Start Zenoh bridge/router then the application
ENTRYPOINT ["./scripts/docker-entrypoint.sh"]
