# Build from repo root: docker build -f examples/orders-api/Dockerfile -t catalyst-example-orders-api .
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

# Copy app source
COPY examples/orders-api examples/orders-api

# Bundle with esbuild
RUN pnpm exec esbuild examples/orders-api/src/index.ts \
  --bundle --platform=node --target=node22 \
  --outfile=dist/index.mjs --format=esm \
  --packages=external

# Create production deployment with flat node_modules
RUN pnpm deploy --filter=@catalyst-examples/orders-api --prod /deploy

# Runtime stage
FROM node:22-alpine
WORKDIR /app

COPY --from=build /deploy/node_modules ./node_modules
COPY --from=build /app/dist/index.mjs ./index.mjs

ENV PORT=8080
EXPOSE 8080

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

CMD ["node", "index.mjs"]
