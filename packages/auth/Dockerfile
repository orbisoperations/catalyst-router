FROM oven/bun:1.3.6 AS base
WORKDIR /app

# Install dependencies into temp directory
# This will cache them and speed up future builds
FROM base AS install
RUN mkdir -p /temp/dev
COPY package.json /temp/dev/
RUN cd /temp/dev && bun install

# Install with --production (exclude devDependencies)
RUN mkdir -p /temp/prod
COPY package.json /temp/prod/
# cant use production flag becuase of frozen-lockfile error: for now just omit dev dependencies
# manually but let lockfile changes
RUN cd /temp/prod && bun install --omit=dev --ignore-scripts

# Copy node_modules from temp directory
# Then copy all (non-ignored) project files into the image
FROM base AS prerelease
COPY --from=install /temp/dev/node_modules node_modules
COPY packages/auth packages/auth

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
