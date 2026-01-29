FROM oven/bun:1.3.6-alpine

WORKDIR /app

# Copy root config
COPY package.json bun.lock ./
COPY package.json bun.lock ./

# Copy orchestrator only package.json to cache dependencies
COPY packages/orchestrator/package.json packages/orchestrator/package.json

# Install dependencies
WORKDIR /app/packages/orchestrator

# Install dependencies (cache dependencies)
RUN bun install --omit=dev --ignore-scripts

# Copy orchestrator package (copy all files)
COPY packages/orchestrator .

ENV PORT=3000
EXPOSE 3000

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

CMD ["bun", "run", "src/server.ts"]
