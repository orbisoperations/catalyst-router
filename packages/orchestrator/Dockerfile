FROM oven/bun:1.3.6

WORKDIR /app

# Copy root config
COPY package.json bun.lockb ./

# Copy orchestrator package
COPY packages/orchestrator packages/orchestrator
RUN rm -rf packages/orchestrator/node_modules

# Install dependencies
WORKDIR /app/packages/orchestrator
RUN bun install --omit=dev --ignore-scripts
ENV PORT=3000
EXPOSE 3000

CMD ["bun", "run", "src/next/index.ts"]
