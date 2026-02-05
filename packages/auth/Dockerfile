# Use shared base image from repository root
# Build from root: docker build -f packages/auth/Dockerfile -t catalyst-auth .
FROM oven/bun:1.3.6-alpine AS base

WORKDIR /app

# Copy root config
COPY package.json bun.lock ./

# Copy all workspace package.json files
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

# Runtime stage
FROM oven/bun:1.3.6-alpine

WORKDIR /app

# Copy from base
COPY --from=base /app /app

# Set working directory to auth package
WORKDIR /app/packages/auth

ENV PORT=5000
EXPOSE 5000

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

CMD ["bun", "run", "src/server.ts"]
