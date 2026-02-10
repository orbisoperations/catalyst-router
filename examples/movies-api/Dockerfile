FROM oven/bun:1.3.6-alpine

WORKDIR /app

# Copy root config
COPY package.json bun.lock ./

# Copy movies-api package dependencies
COPY examples/movies-api/package.json examples/movies-api/package.json

# Install production dependencies
RUN bun install --ignore-scripts --omit=dev

# Copy movies-api package source code
COPY examples/movies-api examples/movies-api

ENV PORT=8080
EXPOSE 8080

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

CMD ["bun", "run", "examples/movies-api/src/index.ts"]
