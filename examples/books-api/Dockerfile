# Build from repo root: docker build -f examples/books-api/Dockerfile -t catalyst-example-books-api .
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
COPY packages/service/package.json packages/service/package.json
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
COPY packages/service/package.json packages/service/package.json
COPY examples/books-api/package.json examples/books-api/package.json
COPY examples/movies-api/package.json examples/movies-api/package.json
COPY examples/orders-api/package.json examples/orders-api/package.json
COPY examples/product-api/package.json examples/product-api/package.json

# Copy app source
COPY examples/books-api examples/books-api
COPY packages/service packages/service

# Recreate workspace symlinks (fast — external deps already cached)
RUN bun install --omit=dev --ignore-scripts

WORKDIR /app/examples/books-api

ENV PORT=8080
EXPOSE 8080

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

CMD ["bun", "run", "src/index.ts"]
