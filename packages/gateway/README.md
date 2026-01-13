# @catalyst/gateway

The GraphQL Federation Gateway for Catalyst Node.

## Features

- **GraphQL Federation**: Can federate multiple GraphQL services into a single graph.
- **Dynamic Configuration**: Configuration (service list) is updated via RPC (WebSocket) without restarting the server.
- **RPC Server**: Uses `capnweb` over WebSocket for high-performance configuration updates.

## Configuration

The gateway is configured primarily via environment variables for startup parameters, and RPC for runtime logic.

### Environment Variables

| Variable | Description | Default |
| :--- | :--- | :--- |
| `PORT` | The HTTP port to listen on. | `4000` |

## RPC API

The gateway exposes a WebSocket RPC endpoint at `/api`.

### Methods

#### `updateConfig(config: GatewayConfig)`

Updates the federation configuration.

**Parameters:**

```typescript
type GatewayConfig = {
  services: {
    name: string;
    url: string;
    token?: string;
  }[];
}
```

## Development

### Start the server

```bash
pnpm dev
# OR with custom port
PORT=4001 pnpm dev
```

### Verification

Run the included test script to verify RPC connectivity and schema reloading:

```bash
pnpm test:rpc
```
