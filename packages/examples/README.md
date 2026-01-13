# Catalyst Examples

This directory contains example services for demonstrating the Catalyst Gateway federation.

## Features

- **Books Service**: A simple GraphQL service managing books.
- **Movies Service**: A simple GraphQL service managing movies.
- **Stitching Directives**: All services implement the standard [`@graphql-tools/stitching-directives`](https://the-guild.dev/graphql/stitching/docs/approaches/stitching-directives) pattern.
- **SDL Exposure**: Each service exposes its full SDL (including directives) via the root query `_sdl: String!`.

## Development

All services use `bun` and `hono` with `graphql-yoga`.

### Running

The examples are best run via the root `packages/examples` test scripts or Docker containers.

```bash
# Run tests (builds containers)
pnpm test
```

### Protocol

The Gateway validates these services by sending a GraphQL query:

```graphql
query {
  _sdl
}
```

This returns the raw SDL string which the Gateway uses to stitch the schema.
