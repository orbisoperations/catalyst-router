# Build from repo root: docker build -f apps/orchestrator/Dockerfile -t catalyst-orchestrator .
FROM oven/bun:1.3.6-alpine AS deps

WORKDIR /app

# Copy root workspace config (includes catalog entries)
COPY package.json bun.lock ./

# Copy ALL workspace package.json files for complete resolution
COPY apps/auth/package.json apps/auth/package.json
COPY apps/cli/package.json apps/cli/package.json
COPY apps/gateway/package.json apps/gateway/package.json
COPY apps/node/package.json apps/node/package.json
COPY apps/orchestrator/package.json apps/orchestrator/package.json
COPY packages/authorization/package.json packages/authorization/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/routing/package.json packages/routing/package.json
COPY packages/sdk/package.json packages/sdk/package.json
COPY packages/telemetry/package.json packages/telemetry/package.json
COPY packages/types/package.json packages/types/package.json
COPY examples/books-api/package.json examples/books-api/package.json
COPY examples/movies-api/package.json examples/movies-api/package.json
COPY examples/orders-api/package.json examples/orders-api/package.json
COPY examples/product-api/package.json examples/product-api/package.json

# Install production dependencies
RUN bun install --omit=dev --ignore-scripts

# Runtime stage
FROM oven/bun:1.3.6-alpine

WORKDIR /app

# Copy external dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy root config + lockfile for workspace resolution
COPY package.json bun.lock ./

# Copy ALL workspace package.json files for workspace resolution
COPY apps/auth/package.json apps/auth/package.json
COPY apps/cli/package.json apps/cli/package.json
COPY apps/gateway/package.json apps/gateway/package.json
COPY apps/node/package.json apps/node/package.json
COPY apps/orchestrator/package.json apps/orchestrator/package.json
COPY packages/authorization/package.json packages/authorization/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/routing/package.json packages/routing/package.json
COPY packages/sdk/package.json packages/sdk/package.json
COPY packages/telemetry/package.json packages/telemetry/package.json
COPY packages/types/package.json packages/types/package.json
COPY examples/books-api/package.json examples/books-api/package.json
COPY examples/movies-api/package.json examples/movies-api/package.json
COPY examples/orders-api/package.json examples/orders-api/package.json
COPY examples/product-api/package.json examples/product-api/package.json

# Copy app source and workspace dependencies
COPY apps/orchestrator apps/orchestrator
COPY apps/auth apps/auth
COPY packages/authorization packages/authorization
COPY packages/config packages/config
COPY packages/routing packages/routing
COPY packages/types packages/types

# Recreate workspace symlinks (fast — external deps already cached)
RUN bun install --omit=dev --ignore-scripts

WORKDIR /app/apps/orchestrator

ENV PORT=3000
EXPOSE 3000

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

CMD ["bun", "run", "src/server.ts"]
