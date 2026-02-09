# Runtime stage (use bun directly)
FROM oven/bun:1.3.6-alpine

WORKDIR /app

# Copy root config
COPY package.json bun.lock ./

# Copy gateway package dependencies
COPY apps/gateway/package.json apps/gateway/package.json

# Install production dependencies
RUN bun install --ignore-scripts --omit=dev

WORKDIR /app/apps/gateway

# Copy source code
COPY apps/gateway .

ENV PORT=4000
EXPOSE 4000

# User
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

CMD ["bun", "run", "src/index.ts"]
