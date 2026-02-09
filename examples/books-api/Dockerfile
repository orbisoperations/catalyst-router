FROM oven/bun:1.3.6-alpine

WORKDIR /app

# Copy root config
COPY package.json bun.lock ./

# Copy books-api package dependencies
COPY examples/books-api/package.json examples/books-api/package.json

# Install production dependencies
RUN bun install --ignore-scripts --omit=dev

# Copy books-api package source code
COPY examples/books-api examples/books-api

# Expose port
ENV PORT=8080
EXPOSE 8080

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

CMD ["bun", "run", "examples/books-api/src/index.ts"]
