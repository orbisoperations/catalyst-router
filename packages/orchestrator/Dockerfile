FROM oven/bun:1.3.6-alpine

WORKDIR /app

# Copy root config
COPY package.json bun.lock ./

# Copy workspace package.json files needed for dependency resolution
COPY packages/orchestrator/package.json packages/orchestrator/package.json
COPY packages/auth/package.json packages/auth/package.json

# Install dependencies (cache dependencies)
RUN bun install --omit=dev --ignore-scripts

COPY packages/auth packages/auth

# Install dependencies
WORKDIR /app/packages/orchestrator

# Copy orchestrator package (copy all files)
COPY packages/orchestrator .

ENV PORT=3000
EXPOSE 3000

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

CMD ["bun", "run", "src/server.ts"]
