# Build from repo root: docker build -f examples/books-api/Dockerfile -t catalyst-example-books-api .
FROM oven/bun:1 AS build

WORKDIR /app

# Copy the entire monorepo (filtered by .dockerignore)
COPY . .

# Install workspace dependencies
RUN bun install --ignore-scripts

# Compile to a standalone binary
WORKDIR /app/examples/books-api
RUN bun build src/index.ts --compile --minify --outfile /app/books-api

# Runtime — minimal image, no bun runtime needed
FROM debian:bookworm-slim

COPY --from=build /app/books-api /books-api

ENV PORT=8080
EXPOSE 8080

RUN addgroup --system appgroup && adduser --system --ingroup appgroup appuser
USER appuser

CMD ["/books-api"]
