# Use shared base image from repository root
# Build from root: docker build -f packages/orchestrator/Dockerfile -t catalyst-node .
FROM oven/bun:1.3.6-alpine AS base

WORKDIR /app

# Copy root config
COPY package.json bun.lock ./

# Copy all workspace package.json files
COPY packages/orchestrator/package.json packages/orchestrator/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY packages/authorization/package.json packages/authorization/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/types/package.json packages/types/package.json

# Install dependencies with proper workspace resolution
RUN bun install --omit=dev --ignore-scripts

# Copy workspace packages source code
COPY packages/auth packages/auth
COPY packages/authorization packages/authorization
COPY packages/config packages/config
COPY packages/types packages/types
COPY packages/orchestrator packages/orchestrator

# Runtime stage
FROM oven/bun:1.3.6-alpine

WORKDIR /app

# Copy from base
COPY --from=base /app /app

# Set working directory to orchestrator package
WORKDIR /app/packages/orchestrator

ENV PORT=3000
EXPOSE 3000

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

CMD ["bun", "run", "src/server.ts"]
