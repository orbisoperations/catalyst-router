# Build from repo root: docker build -f examples/zenoh-tak-adapter/Dockerfile -t zenoh-tak-adapter .
#
# Multi-stage build:
#   1. Copy zenohd from the official Zenoh image (no Rust compilation needed)
#   2. Bundle the Node.js adapter app with esbuild
#   3. Combine into a minimal runtime image

# --- Stage 1: Get zenohd from official image ---
FROM eclipse/zenoh:latest AS zenoh

# --- Stage 2: Build the Node.js app ---
FROM node:22-alpine AS build

WORKDIR /app

# Copy the entire monorepo (filtered by .dockerignore)
COPY . .

# Install workspace dependencies
RUN corepack enable && pnpm install --frozen-lockfile

# Bundle to a single file with esbuild
WORKDIR /app/examples/zenoh-tak-adapter
RUN pnpm exec esbuild src/index.ts --bundle --platform=node --target=node22 \
  --outfile=/app/zenoh-tak-adapter.mjs --format=esm

# --- Stage 3: Runtime ---
# Alpine to match the eclipse/zenoh musl-linked zenohd binary.
FROM node:22-alpine

# Install shared libraries needed by zenohd (musl-linked)
RUN apk add --no-cache libgcc libstdc++

# zenohd + plugins from the official Zenoh image
COPY --from=zenoh /zenohd /usr/local/bin/zenohd
# REST plugin needed for local data access
COPY --from=zenoh /libzenoh_plugin_rest.so /usr/local/lib/
COPY --from=zenoh /libzenoh_plugin_storage_manager.so /usr/local/lib/

# Bundled Node.js app
COPY --from=build /app/zenoh-tak-adapter.mjs /app/index.mjs

# zenohd plugin search path
ENV ZENOH_PLUGIN_SEARCH_DIR=/usr/local/lib

ENV ZENOH_CONNECT=tcp/envoy-proxy-c:10000
ENV SUBSCRIBE_KEY=demo/radar/tracks
ENV ZENOHD_BIN=/usr/local/bin/zenohd
ENV ZENOHD_REST_PORT=8080

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

CMD ["node", "/app/index.mjs"]
