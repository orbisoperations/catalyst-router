FROM node:22-alpine AS builder
WORKDIR /app

# Strip devDependencies that use pnpm catalog references (catalog:testing)
# which require the workspace root. We only need runtime deps + build tools.
COPY package.json ./
RUN corepack enable && \
    node -e " \
    const pkg = JSON.parse(require('fs').readFileSync('package.json','utf8')); \
    delete pkg.devDependencies; \
    require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2));" && \
    pnpm install --no-frozen-lockfile && \
    pnpm add -D esbuild esbuild-plugin-wasm typescript

# Copy source, build script, and Zenoh configs
COPY src ./src
COPY tsconfig.json build.mjs ./

# Build the application (requires src/index.ts)
RUN node build.mjs

FROM node:22-alpine AS production

WORKDIR /app

# Zenoh version must match across zenohd and the remote-api plugin
ARG ZENOH_VERSION=1.7.2

# Install Zenoh router (zenohd) from the Eclipse Debian repo
# Note: Using Alpine, so we install from pre-built binaries instead
RUN apk add --no-cache ca-certificates curl libgcc libstdc++

# Install zenohd from GitHub releases (Alpine-compatible static binary)
RUN ARCH=$(uname -m) && \
    case "$ARCH" in \
    aarch64) ZENOH_ARCH="aarch64" ;; \
    x86_64)  ZENOH_ARCH="x86_64"  ;; \
    *)       echo "Unsupported arch: $ARCH" && exit 1 ;; \
    esac && \
    echo "Downloading zenoh ${ZENOH_VERSION} for ${ZENOH_ARCH}-unknown-linux-musl..." && \
    curl -fsSL -o /tmp/zenoh.zip \
    "https://download.eclipse.org/zenoh/zenoh/${ZENOH_VERSION}/zenoh-${ZENOH_VERSION}-${ZENOH_ARCH}-unknown-linux-musl-standalone.zip" && \
    unzip -o /tmp/zenoh.zip -d /tmp/zenoh && \
    cp /tmp/zenoh/zenohd /usr/local/bin/ && \
    cp /tmp/zenoh/libzenoh_plugin_rest.so /usr/local/lib/ 2>/dev/null || true && \
    cp /tmp/zenoh/libzenoh_plugin_storage_manager.so /usr/local/lib/ 2>/dev/null || true && \
    chmod +x /usr/local/bin/zenohd && \
    rm -rf /tmp/zenoh /tmp/zenoh.zip

# Install zenoh-plugin-remote-api
RUN ARCH=$(uname -m) && \
    case "$ARCH" in \
    aarch64) ZENOH_ARCH="aarch64" ;; \
    x86_64)  ZENOH_ARCH="x86_64"  ;; \
    *)       echo "Unsupported arch: $ARCH" && exit 1 ;; \
    esac && \
    echo "Downloading zenoh-plugin-remote-api ${ZENOH_VERSION} for ${ZENOH_ARCH}-unknown-linux-musl..." && \
    curl -fsSL -o /tmp/zenoh-ts.zip \
    "https://download.eclipse.org/zenoh/zenoh-plugin-remote-api/${ZENOH_VERSION}/zenoh-ts-${ZENOH_VERSION}-${ZENOH_ARCH}-unknown-linux-musl-standalone.zip" && \
    unzip -o /tmp/zenoh-ts.zip -d /tmp/zenoh-ts && \
    find /tmp/zenoh-ts -name '*.so' -exec cp {} /usr/local/lib/ \; && \
    rm -rf /tmp/zenoh-ts /tmp/zenoh-ts.zip && \
    echo "remote-api plugin installed:" && \
    find /usr/local/lib -name '*remote_api*'

# Install Node.js runtime dependencies for the bundled app
RUN corepack enable
COPY package.json pnpm-lock.yaml* ./
RUN node -e " \
    const pkg = JSON.parse(require('fs').readFileSync('package.json','utf8')); \
    delete pkg.devDependencies; \
    require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2));" && \
    pnpm install --prod --no-frozen-lockfile

COPY --from=builder /app/dist /app/dist

COPY build/zenoh-bridge-config.json5 ./
COPY scripts/docker-entrypoint.sh ./scripts/

RUN chmod +x ./scripts/docker-entrypoint.sh

# Environment variables
ENV NODE_ENV=production

# Start Zenoh bridge/router then the application
ENTRYPOINT ["./scripts/docker-entrypoint.sh"]
