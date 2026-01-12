# Build from monorepo root context to resolve catalog references
FROM oven/bun:1 AS builder
WORKDIR /app

# Copy workspace config files (catalog definitions are in root package.json)
COPY package.json bun.lockb ./
COPY packages/orchestrator/package.json ./packages/orchestrator/

# Install from workspace root - bun resolves catalogs from root package.json
RUN bun install --omit dev

# Copy source code
COPY packages/orchestrator/src ./packages/orchestrator/src
COPY packages/orchestrator/tsconfig.json ./packages/orchestrator/

# Build binary
WORKDIR /app/packages/orchestrator
RUN bun build --compile --minify --outfile server src/index.ts

# Runtime stage
FROM gcr.io/distroless/base-nossl-debian12
WORKDIR /app

COPY --from=builder /app/packages/orchestrator/server .

ENV PORT=3000
EXPOSE 3000
CMD ["./server"]
