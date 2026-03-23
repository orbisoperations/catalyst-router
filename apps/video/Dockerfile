# Build from repo root: docker build -f apps/video/Dockerfile -t catalyst-video .
#
# Multi-stage build: Node.js service + MediaMTX Go binary.
# MediaMTX is downloaded as a pre-built binary for the target architecture
# rather than compiled from source, matching the plan requirement for
# multi-arch support (x86_64 + ARM64).

# ---------------------------------------------------------------------------
# Stage 1: Download MediaMTX binary (multi-arch via TARGETARCH)
# ---------------------------------------------------------------------------
FROM alpine:3.20 AS mediamtx

ARG TARGETARCH
ARG MEDIAMTX_VERSION=1.16.0

RUN apk add --no-cache curl tar \
  && ARCH=$(case "${TARGETARCH}" in \
       amd64) echo "amd64" ;; \
       arm64) echo "arm64" ;; \
       *) echo "amd64" ;; \
     esac) \
  && curl -fsSL "https://github.com/bluenviron/mediamtx/releases/download/v${MEDIAMTX_VERSION}/mediamtx_v${MEDIAMTX_VERSION}_linux_${ARCH}.tar.gz" \
     | tar xz -C /usr/local/bin mediamtx \
  && chmod +x /usr/local/bin/mediamtx

# ---------------------------------------------------------------------------
# Stage 2: Build Node.js service
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

RUN corepack enable

# Copy workspace manifests for dependency caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/video/package.json apps/video/
COPY packages/authorization/package.json packages/authorization/
COPY packages/config/package.json packages/config/
COPY packages/routing/package.json packages/routing/
COPY packages/types/package.json packages/types/
COPY packages/service/package.json packages/service/
COPY packages/telemetry/package.json packages/telemetry/

# Install all dependencies
RUN pnpm install --frozen-lockfile

# Copy source for the video service and its workspace dependencies
COPY apps/video apps/video
COPY packages/authorization packages/authorization
COPY packages/config packages/config
COPY packages/routing packages/routing
COPY packages/types packages/types
COPY packages/service packages/service
COPY packages/telemetry packages/telemetry

# Bundle with esbuild
RUN pnpm exec esbuild apps/video/src/server.ts \
  --bundle --platform=node --target=node22 \
  --outfile=dist/server.mjs --format=esm \
  --external:@cedar-policy/cedar-wasm \
  --loader:.cedar=text --loader:.cedarschema=text \
  --banner:js='import{createRequire}from"module";import{fileURLToPath as __file}from"url";import{dirname as __dir}from"path";const require=createRequire(import.meta.url),__filename=__file(import.meta.url),__dirname=__dir(__filename);'

# Create production deployment with flat node_modules
RUN pnpm deploy --filter=@catalyst/video-service --prod /deploy

# ---------------------------------------------------------------------------
# Stage 3: Runtime
# ---------------------------------------------------------------------------
FROM node:22-alpine
WORKDIR /app

# curl is needed for MediaMTX lifecycle hooks (runOnReady/runOnNotReady)
RUN apk add --no-cache curl

# MediaMTX binary from stage 1
COPY --from=mediamtx /usr/local/bin/mediamtx /usr/local/bin/mediamtx

# Node.js service bundle
COPY --from=build /deploy/node_modules ./node_modules
COPY --from=build /app/dist/server.mjs ./server.mjs

ENV PORT=3000
ENV MEDIAMTX_PATH=/usr/local/bin/mediamtx

# HTTP (hooks + health) and RTSP
EXPOSE 3000 8554

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

CMD ["node", "server.mjs"]
