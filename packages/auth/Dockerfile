FROM oven/bun:1.3.6 AS base
WORKDIR /app

# Copy root config
COPY package.json bun.lock ./

# Copy workspace package.json files needed for dependency resolution
COPY packages/auth/package.json packages/auth/package.json
COPY packages/authorization/package.json packages/authorization/package.json
COPY packages/config/package.json packages/config/package.json

# Install dependencies into temp directory
# This will cache them and speed up future builds
FROM base AS install
RUN mkdir -p /temp/dev
COPY package.json bun.lock /temp/dev/
RUN mkdir -p /temp/dev/packages/auth /temp/dev/packages/authorization /temp/dev/packages/config
COPY packages/auth/package.json /temp/dev/packages/auth/
COPY packages/authorization/package.json /temp/dev/packages/authorization/
COPY packages/config/package.json /temp/dev/packages/config/
# ensure all workspace packages are at least defined to satisfy bun
RUN cd /temp/dev && bun install --ignore-scripts

# Install with --production (exclude devDependencies)
RUN mkdir -p /temp/prod
COPY package.json bun.lock /temp/prod/
RUN mkdir -p /temp/prod/packages/auth /temp/prod/packages/authorization /temp/prod/packages/config
COPY packages/auth/package.json /temp/prod/packages/auth/
COPY packages/authorization/package.json /temp/prod/packages/authorization/
COPY packages/config/package.json /temp/prod/packages/config/
# cant use production flag becuase of frozen-lockfile error: for now just omit dev dependencies
# manually but let lockfile changes
RUN cd /temp/prod && bun install --omit=dev --ignore-scripts

# Copy node_modules from temp directory
# Then copy all (non-ignored) project files into the image
FROM base AS prerelease
COPY --from=install /temp/dev/node_modules node_modules
COPY packages/auth packages/auth
COPY packages/authorization packages/authorization
COPY packages/config packages/config

# [optional] tests & build
ENV NODE_ENV=production
# RUN bun test

# copy production dependencies and source code into final image
FROM base AS release
COPY --from=install /temp/prod/node_modules node_modules
COPY --from=prerelease /app/packages/auth/src src
COPY --from=prerelease /app/packages/auth/package.json .
COPY --from=prerelease /app/packages/auth/tsconfig.json .

# run the app
USER bun
EXPOSE 4020/tcp
ENTRYPOINT [ "bun", "run", "src/server.ts" ]
