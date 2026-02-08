# Runtime stage (use bun directly)
FROM oven/bun:1.3.6-alpine

WORKDIR /app

# Copy root config
COPY package.json bun.lock ./

# Copy Gateway Dependencies package.json files (types and telemetry)
COPY packages/types/package.json packages/types/package.json
COPY packages/telemetry/package.json packages/telemetry/package.json

# Copy Gateway Dependencies Code (types and telemetry)
COPY packages/types packages/types
COPY packages/telemetry packages/telemetry

# Copy Gateway package dependencies
COPY packages/gateway/package.json packages/gateway/package.json

# Install production dependencies
RUN bun install --ignore-scripts --omit=dev

WORKDIR /app/packages/gateway

# Copy source code
COPY packages/gateway .

ENV PORT=4000
EXPOSE 4000

# User
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

CMD ["bun", "run", "src/index.ts"]
