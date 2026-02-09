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
