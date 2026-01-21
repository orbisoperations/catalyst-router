# Runtime stage (use bun directly)
FROM oven/bun:1
WORKDIR /app

# Copy root config
COPY package.json bun.lockb ./

# Copy source
COPY packages/gateway packages/gateway

# Remove host node_modules to avoid broken symlinks
RUN rm -rf packages/gateway/node_modules

# Install dependencies from root
RUN bun install

WORKDIR /app/packages/gateway
ENV PORT=4000
EXPOSE 4000
CMD ["bun", "run", "src/index.ts"]
