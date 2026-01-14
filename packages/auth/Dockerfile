# Build from monorepo root context for consistency with other packages
FROM oven/bun:1 AS builder
WORKDIR /app

# Copy workspace config files (catalog definitions are in root package.json)
COPY package.json bun.lockb ./
COPY packages/auth/package.json ./packages/auth/

# Install from workspace root
RUN bun install --filter @catalyst/auth

# Copy source code
COPY packages/auth/src ./packages/auth/src
COPY packages/auth/tsconfig.json ./packages/auth/

# Runtime stage
FROM oven/bun:1
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/auth ./packages/auth

WORKDIR /app/packages/auth

USER bun
ENV PORT=4020
EXPOSE 4020
CMD ["bun", "run", "src/server.ts"]
