# Build from repo root: docker build -f examples/zenoh-radar-publisher/Dockerfile -t zenoh-radar-publisher .
FROM oven/bun:1 AS build

WORKDIR /app

# Copy the entire monorepo (filtered by .dockerignore)
COPY . .

# Install workspace dependencies
RUN bun install --ignore-scripts

# Compile to a standalone binary
WORKDIR /app/examples/zenoh-radar-publisher
RUN bun build src/index.ts --compile --minify --outfile /app/zenoh-radar-publisher

# Runtime — minimal image, no bun runtime needed
FROM debian:bookworm-slim

COPY --from=build /app/zenoh-radar-publisher /zenoh-radar-publisher

ENV ZENOH_ROUTER_URL=http://zenoh-router:8000
ENV PUBLISH_KEY=demo/radar/tracks
ENV PUBLISH_INTERVAL_MS=1000

RUN addgroup --system appgroup && adduser --system --ingroup appgroup appuser
USER appuser

CMD ["/zenoh-radar-publisher"]
