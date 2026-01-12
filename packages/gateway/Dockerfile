# Build from monorepo root context to resolve catalog references
FROM oven/bun:1 AS builder
WORKDIR /app

# Copy workspace config files (catalog definitions are in root package.json)
COPY package.json bun.lockb ./
COPY packages/gateway/package.json ./packages/gateway/

# Install from workspace root - bun resolves catalogs from root package.json
RUN bun install --omit dev

# Copy source code
COPY packages/gateway/src ./packages/gateway/src
COPY packages/gateway/tsconfig.json ./packages/gateway/

# Build binary
WORKDIR /app/packages/gateway
RUN bun build --compile --minify --outfile server src/index.ts

# Runtime stage
# We use distroless/base-nossl-debian12 for a minimal glibc image
FROM gcr.io/distroless/base-nossl-debian12
WORKDIR /app

COPY --from=builder /app/packages/gateway/server .

ENV PORT=4000
EXPOSE 4000
CMD ["./server"]
