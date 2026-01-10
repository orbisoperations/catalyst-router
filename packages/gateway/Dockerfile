# Builder stage
FROM oven/bun:1 AS builder
WORKDIR /app
COPY package.json ./
RUN bun install
COPY . .
RUN bun build --compile --minify --outfile server src/index.ts

# Runtime stage
# We use distroless/base-nossl-debian12 for a minimal glibc image
FROM gcr.io/distroless/base-nossl-debian12
WORKDIR /app
COPY --from=builder /app/server .
ENV PORT=4000
EXPOSE 4000
CMD ["./server"]
