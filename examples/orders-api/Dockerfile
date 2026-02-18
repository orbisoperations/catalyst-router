# Build from repo root: docker build -f examples/orders-api/Dockerfile -t catalyst-example-orders-api .
FROM node:22-alpine AS deps

# Bun for workspace-aware package management; build tools for native addons
RUN apk add --no-cache python3 make g++ && npm install -g bun

WORKDIR /app

# Copy root workspace config (includes catalog entries)
COPY package.json bun.lock ./

# Copy ALL workspace package.json files for complete resolution
COPY apps/auth/package.json apps/auth/package.json
COPY apps/cli/package.json apps/cli/package.json
COPY apps/envoy/package.json apps/envoy/package.json
COPY apps/gateway/package.json apps/gateway/package.json
COPY apps/node/package.json apps/node/package.json
COPY apps/orchestrator/package.json apps/orchestrator/package.json
COPY packages/authorization/package.json packages/authorization/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/routing/package.json packages/routing/package.json
COPY packages/sdk/package.json packages/sdk/package.json
COPY packages/telemetry/package.json packages/telemetry/package.json
COPY packages/types/package.json packages/types/package.json
COPY packages/pki/package.json packages/pki/package.json
COPY packages/service/package.json packages/service/package.json
COPY examples/books-api/package.json examples/books-api/package.json
COPY examples/movies-api/package.json examples/movies-api/package.json
COPY examples/orders-api/package.json examples/orders-api/package.json
COPY examples/product-api/package.json examples/product-api/package.json

# Install production dependencies (native addons compile for Node.js ABI)
# Stub husky (devDep, not installed with --omit=dev) so prepare script succeeds
RUN printf '#!/bin/sh\nexit 0\n' > /usr/local/bin/husky && chmod +x /usr/local/bin/husky && bun install --omit=dev

# Build stage — workspace symlinks
FROM oven/bun:1.3.6-alpine AS build

WORKDIR /app

# Copy external dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy root config + lockfile for workspace resolution
COPY package.json bun.lock ./

# Copy ALL workspace package.json files for workspace resolution
COPY apps/auth/package.json apps/auth/package.json
COPY apps/cli/package.json apps/cli/package.json
COPY apps/envoy/package.json apps/envoy/package.json
COPY apps/gateway/package.json apps/gateway/package.json
COPY apps/node/package.json apps/node/package.json
COPY apps/orchestrator/package.json apps/orchestrator/package.json
COPY packages/authorization/package.json packages/authorization/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/routing/package.json packages/routing/package.json
COPY packages/sdk/package.json packages/sdk/package.json
COPY packages/telemetry/package.json packages/telemetry/package.json
COPY packages/types/package.json packages/types/package.json
COPY packages/pki/package.json packages/pki/package.json
COPY packages/service/package.json packages/service/package.json
COPY examples/books-api/package.json examples/books-api/package.json
COPY examples/movies-api/package.json examples/movies-api/package.json
COPY examples/orders-api/package.json examples/orders-api/package.json
COPY examples/product-api/package.json examples/product-api/package.json

# Copy app source
COPY examples/orders-api examples/orders-api

# Recreate workspace symlinks (fast — external deps already cached)
RUN bun install --omit=dev --ignore-scripts

# Runtime stage — Node.js
FROM node:22-alpine

RUN npm install -g tsx

WORKDIR /app
COPY --from=build /app ./

WORKDIR /app/examples/orders-api

ENV PORT=8080
EXPOSE 8080

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

CMD ["tsx", "src/index.ts"]
