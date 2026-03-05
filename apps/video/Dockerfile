# Build from repo root: docker build -f apps/video/Dockerfile -t catalyst-video .
#
# Multi-stage build:
#   Stage 1 (mediamtx): Download MediaMTX binary for target platform
#   Stage 2 (build):    Build TypeScript with esbuild
#   Stage 3 (runtime):  Node.js + MediaMTX binary + compiled JS + curl

# ---------------------------------------------------------------------------
# Stage 1: Download MediaMTX binary
# ---------------------------------------------------------------------------
FROM alpine:3.21 AS mediamtx

ARG TARGETARCH
ARG MEDIAMTX_VERSION=1.12.2

RUN apk add --no-cache curl tar && \
    ARCH=$(case "$TARGETARCH" in \
      amd64) echo "linux_amd64" ;; \
      arm64) echo "linux_arm64" ;; \
      *) echo "linux_amd64" ;; \
    esac) && \
    curl -fsSL "https://github.com/bluenviron/mediamtx/releases/download/v${MEDIAMTX_VERSION}/mediamtx_v${MEDIAMTX_VERSION}_${ARCH}.tar.gz" \
      | tar xz -C /usr/local/bin mediamtx && \
    chmod +x /usr/local/bin/mediamtx

# ---------------------------------------------------------------------------
# Stage 2: Build TypeScript
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

RUN corepack enable

# Copy workspace manifests for dependency caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/auth/package.json apps/auth/
COPY apps/cli/package.json apps/cli/
COPY apps/envoy/package.json apps/envoy/
COPY apps/gateway/package.json apps/gateway/
COPY apps/node/package.json apps/node/
COPY apps/orchestrator/package.json apps/orchestrator/
COPY apps/video/package.json apps/video/
COPY packages/authorization/package.json packages/authorization/
COPY packages/config/package.json packages/config/
COPY packages/routing/package.json packages/routing/
COPY packages/sdk/package.json packages/sdk/
COPY packages/telemetry/package.json packages/telemetry/
COPY packages/types/package.json packages/types/
COPY packages/service/package.json packages/service/
COPY examples/books-api/package.json examples/books-api/
COPY examples/movies-api/package.json examples/movies-api/
COPY examples/orders-api/package.json examples/orders-api/
COPY examples/product-api/package.json examples/product-api/

# Install all dependencies
RUN pnpm install --frozen-lockfile

# Copy app source and workspace dependencies
COPY apps/video apps/video
COPY packages/telemetry packages/telemetry
COPY packages/service packages/service
COPY packages/config packages/config
COPY packages/routing packages/routing

# Bundle with esbuild — all code inlined.
# Banner provides CJS compatibility (require, __dirname) for bundled npm packages.
RUN pnpm exec esbuild apps/video/src/index.ts \
  --bundle --platform=node --target=node22 \
  --outfile=dist/server.mjs --format=esm \
  --banner:js='import{createRequire}from"module";import{fileURLToPath as __file}from"url";import{dirname as __dir}from"path";const require=createRequire(import.meta.url),__filename=__file(import.meta.url),__dirname=__dir(__filename);'

# Create production deployment with flat node_modules
RUN pnpm deploy --filter=@catalyst/video-service --prod /deploy

# ---------------------------------------------------------------------------
# Stage 3: Runtime
# ---------------------------------------------------------------------------
FROM node:22-alpine
WORKDIR /app

# ADR-0011: Assert OpenSSL 3.5+ for PQC (CNSA 2.0) compliance
RUN node -e "const v = process.versions.openssl.split('.').map(Number); \
  if(v[0]<3||v[1]<5) throw new Error('OpenSSL 3.5+ required, got '+process.versions.openssl)"

# curl is required by MediaMTX hooks (runOnReady/runOnNotReady call back to VideoService)
RUN apk add --no-cache curl

COPY --from=mediamtx /usr/local/bin/mediamtx /usr/local/bin/mediamtx
COPY --from=build /deploy/node_modules ./node_modules
COPY --from=build /app/dist/server.mjs ./server.mjs

ENV PORT=6000
EXPOSE 6000 8554 8888 8889 8890

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

CMD ["node", "server.mjs"]
