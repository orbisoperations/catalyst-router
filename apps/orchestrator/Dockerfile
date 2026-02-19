# Build from repo root: docker build -f apps/orchestrator/Dockerfile -t catalyst-orchestrator .
FROM node:22-alpine AS build
WORKDIR /app

RUN corepack enable
# Build tools for native addons (better-sqlite3, argon2, etc.)
RUN apk add --no-cache python3 make g++

# Copy workspace manifests for dependency caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/auth/package.json apps/auth/
COPY apps/cli/package.json apps/cli/
COPY apps/envoy/package.json apps/envoy/
COPY apps/gateway/package.json apps/gateway/
COPY apps/node/package.json apps/node/
COPY apps/orchestrator/package.json apps/orchestrator/
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
COPY apps/orchestrator apps/orchestrator
COPY apps/auth apps/auth
COPY apps/envoy apps/envoy
COPY packages/authorization packages/authorization
COPY packages/config packages/config
COPY packages/routing packages/routing
COPY packages/types packages/types
COPY packages/service packages/service
COPY packages/telemetry packages/telemetry

# Bundle with esbuild
RUN pnpm exec esbuild apps/orchestrator/src/server.ts \
  --bundle --platform=node --target=node22 \
  --outfile=dist/server.mjs --format=esm \
  --packages=external --loader:.cedar=text

# Create production deployment with flat node_modules
RUN pnpm deploy --filter=@catalyst/orchestrator-service --prod /deploy

# Runtime stage
FROM node:22-alpine
WORKDIR /app

COPY --from=build /deploy/node_modules ./node_modules
COPY --from=build /app/dist/server.mjs ./server.mjs

ENV PORT=3000
EXPOSE 3000

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

CMD ["node", "server.mjs"]
