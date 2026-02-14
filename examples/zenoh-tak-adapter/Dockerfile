# Build from repo root: docker build -f examples/zenoh-tak-adapter/Dockerfile -t zenoh-tak-adapter .
#
# Multi-stage build:
#   1. Copy zenohd from the official Zenoh image (no Rust compilation needed)
#   2. Compile the Bun adapter app to a standalone binary
#   3. Combine into a minimal runtime image

# --- Stage 1: Get zenohd from official image ---
FROM eclipse/zenoh:latest AS zenoh

# --- Stage 2: Build the Bun app ---
# Use Alpine-based Bun so the compiled binary links against musl (matches runtime).
FROM oven/bun:1-alpine AS bun-build

WORKDIR /app

# Copy the entire monorepo (filtered by .dockerignore)
COPY . .

# Install workspace dependencies
RUN bun install --ignore-scripts

# Compile to a standalone binary (musl-linked, runs on Alpine)
WORKDIR /app/examples/zenoh-tak-adapter
RUN bun build src/index.ts --compile --minify --outfile /app/zenoh-tak-adapter

# --- Stage 3: Runtime ---
# Alpine to match the eclipse/zenoh musl-linked zenohd binary.
# Bun app also built on Alpine (oven/bun:1-alpine) for musl compatibility.
FROM alpine:3.21

# Install shared libraries needed by zenohd (musl-linked)
RUN apk add --no-cache libgcc libstdc++

# zenohd + plugins from the official Zenoh image
COPY --from=zenoh /zenohd /usr/local/bin/zenohd
# REST plugin needed for local data access
COPY --from=zenoh /libzenoh_plugin_rest.so /usr/local/lib/
COPY --from=zenoh /libzenoh_plugin_storage_manager.so /usr/local/lib/

# Bun app binary (standalone, works on Alpine)
COPY --from=bun-build /app/zenoh-tak-adapter /zenoh-tak-adapter

# zenohd plugin search path
ENV ZENOH_PLUGIN_SEARCH_DIR=/usr/local/lib

ENV ZENOH_CONNECT=tcp/envoy-proxy-c:10000
ENV SUBSCRIBE_KEY=demo/radar/tracks
ENV ZENOHD_BIN=/usr/local/bin/zenohd
ENV ZENOHD_REST_PORT=8080

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

CMD ["/zenoh-tak-adapter"]
