# @catalyst/sdk

Standardized service entrypoint for Catalyst Node services. Reduces boilerplate for creating HTTP services with health checks, graceful shutdown, and optional telemetry.

## Installation

```bash
bun add @catalyst/sdk
```

## Quick Start

```typescript
import { CatalystService } from '@catalyst/sdk'

const service = new CatalystService({
  name: 'my-service',
  port: 3000,
})

// Add routes
service.app.get('/api/users', (c) => c.json({ users: [] }))

// Register shutdown callbacks
service.onShutdown(async () => {
  await database.close()
})

// Export for Bun
export default service.serve()
```

## Features

- **Hono app** — Pre-configured HTTP server
- **Health endpoint** — `/health` mounted by default
- **Graceful shutdown** — SIGTERM/SIGINT handling with timeout
- **WebSocket support** — Ready for Cap'n Proto RPC
- **OTEL integration** — Optional telemetry via `@catalyst/telemetry`

## Configuration

### `ServiceOptions`

| Option       | Type     | Default                      | Description                               |
| ------------ | -------- | ---------------------------- | ----------------------------------------- |
| `name`       | `string` | **required**                 | Service name (used for logging/telemetry) |
| `port`       | `number` | `process.env.PORT \|\| 3000` | Port to listen on                         |
| `hostname`   | `string` | `"0.0.0.0"`                  | Hostname to bind to                       |
| `healthPath` | `string` | `"/health"`                  | Health check endpoint path                |

## API

### `service.app`

The underlying [Hono](https://hono.dev) application. Add routes, middleware, etc.

```typescript
service.app.get('/api/items', (c) => c.json({ items: [] }))
service.app.post('/api/items', async (c) => {
  const body = await c.req.json()
  return c.json({ id: 1, ...body }, 201)
})

// Mount sub-applications
service.app.route('/rpc', rpcApp)
```

### `service.name`

The service name (read-only).

```typescript
console.log(`Starting ${service.name}`)
```

### `service.port`

The port number (read-only).

### `service.hostname`

The hostname (read-only).

### `service.tracer`

Get an OpenTelemetry tracer for this service. Returns a no-op tracer if `@catalyst/telemetry` isn't initialized.

```typescript
const span = service.tracer.startSpan('custom-operation')
// ... do work
span.end()
```

### `service.meter`

Get an OpenTelemetry meter for this service. Returns a no-op meter if `@catalyst/telemetry` isn't initialized.

```typescript
const counter = service.meter.createCounter('custom.counter')
counter.add(1)
```

### `service.onShutdown(callback)`

Register a callback to run during graceful shutdown. Callbacks are executed sequentially in registration order.

```typescript
service.onShutdown(async () => {
  await database.close()
})

service.onShutdown(() => {
  console.log('Goodbye!')
})
```

### `service.serve()`

Returns the Bun server configuration. Must be the default export.

```typescript
export default service.serve()
// Returns: { fetch, port, hostname, websocket }
```

### `service.shutdown(timeoutMs?)`

Manually trigger shutdown. Usually not needed — SIGTERM/SIGINT are handled automatically.

```typescript
await service.shutdown(5000) // 5 second timeout
```

## With Telemetry

For full observability, initialize `@catalyst/telemetry` before creating the service:

```typescript
import { initTelemetry, shutdown } from '@catalyst/telemetry'
import { telemetryMiddleware } from '@catalyst/telemetry/middleware/hono'
import { CatalystService } from '@catalyst/sdk'

// Initialize telemetry FIRST
await initTelemetry({
  serviceName: 'my-service',
  otlpEndpoint: 'http://localhost:4318',
})

const service = new CatalystService({ name: 'my-service' })

// Add telemetry middleware
service.app.use(
  '*',
  telemetryMiddleware({
    ignorePaths: ['/health'],
  })
)

// Add routes
service.app.get('/api/data', (c) => c.json({ data: [] }))

// Shutdown telemetry on service shutdown
service.onShutdown(shutdown)

export default service.serve()
```

## Health Endpoint

The health endpoint returns:

```json
{ "status": "ok" }
```

Customize the path:

```typescript
const service = new CatalystService({
  name: 'my-service',
  healthPath: '/ready',
})
```

## Graceful Shutdown

On SIGTERM or SIGINT:

1. Signal handlers are removed (prevents double-shutdown)
2. Registered `onShutdown` callbacks run sequentially
3. Timeout after 30 seconds (configurable via `shutdown(timeoutMs)`)
4. Process exits with code 0 (or 1 on error)

## WebSocket Support

The `serve()` return includes Hono's WebSocket handler for protocols like Cap'n Proto RPC:

```typescript
import { upgradeWebSocket } from 'hono/bun'

service.app.get(
  '/ws',
  upgradeWebSocket((c) => ({
    onMessage(event, ws) {
      ws.send(`Echo: ${event.data}`)
    },
  }))
)

export default service.serve()
// Includes: { fetch, port, hostname, websocket }
```

## Environment Variables

| Variable | Description                                      |
| -------- | ------------------------------------------------ |
| `PORT`   | Port to listen on (overridden by `options.port`) |

## License

MIT
