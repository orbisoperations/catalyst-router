# Build from repo root: docker build -f examples/zenoh-radar-publisher/Dockerfile -t zenoh-radar-publisher .
FROM node:22-alpine AS build

WORKDIR /app

# Copy the entire monorepo (filtered by .dockerignore)
COPY . .

# Install workspace dependencies
RUN corepack enable && pnpm install --frozen-lockfile

# Bundle to a single file with esbuild
WORKDIR /app/examples/zenoh-radar-publisher
RUN pnpm exec esbuild src/index.ts --bundle --platform=node --target=node22 \
  --outfile=/app/zenoh-radar-publisher.mjs --format=esm

# Runtime — minimal image
FROM node:22-alpine

COPY --from=build /app/zenoh-radar-publisher.mjs /app/index.mjs

ENV ZENOH_ROUTER_URL=http://zenoh-router:8000
ENV PUBLISH_KEY=demo/radar/tracks
ENV PUBLISH_INTERVAL_MS=1000

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

CMD ["node", "/app/index.mjs"]
