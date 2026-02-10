# @catalyst/service

Base classes for building Catalyst services with unified config injection, telemetry auto-setup, and lifecycle management.

## Overview

This package provides two building blocks:

- **`CatalystService`** -- abstract base class that every Catalyst service extends.
- **`catalystHonoServer()`** -- generic Hono server wrapper with health endpoint, telemetry middleware, and graceful shutdown.

Services own their **routes** (a Hono handler) but do NOT own the HTTP server. This separation enables composing multiple services onto a single port.

## Usage

### Defining a service

Subclass `CatalystService`, provide `info` and `handler`, and override `onInitialize()`:

```typescript
import { CatalystService, type CatalystServiceOptions } from '@catalyst/service'
import { Hono } from 'hono'

class AuthService extends CatalystService {
  readonly info = { name: 'auth', version: '0.0.0' }
  readonly handler = new Hono()

  constructor(options: CatalystServiceOptions) {
    super(options)
  }

  protected async onInitialize(): Promise<void> {
    // Telemetry is available via this.telemetry
    // Config is available via this.config
    this.handler.get('/whoami', (c) => c.json({ service: this.info.name }))
  }

  protected async onShutdown(): Promise<void> {
    // Clean up connections, intervals, etc.
  }
}
```

### Starting a service

Use the static `create()` factory, then wrap the handler in a server:

```typescript
import { loadDefaultConfig } from '@catalyst/config'
import { catalystHonoServer } from '@catalyst/service'
import { AuthService } from './service.js'

const config = loadDefaultConfig()
const auth = await AuthService.create({ config })

catalystHonoServer(auth.handler, {
  services: [auth],
  port: config.port,
}).start()
```

### Composing multiple services on one port

Mount multiple service handlers onto a shared Hono app:

```typescript
const app = new Hono()
app.route('/auth', auth.handler)
app.route('/gateway', gateway.handler)

catalystHonoServer(app, {
  services: [auth, gateway],
  port: config.port,
}).start()
```

## Lifecycle

```
create() ─► constructor ─► initialize() ─► ready ─► shutdown() ─► stopped
                              │                        │
                         builds telemetry         calls onShutdown()
                         calls onInitialize()     flushes telemetry
```

- `CatalystService.create(options)` -- constructs and initializes in one call.
- `initialize()` -- sets up telemetry (or reuses pre-built), then calls `onInitialize()`.
- `shutdown()` -- calls `onShutdown()`, then tears down telemetry (if owned).

The server (`CatalystHonoServer`) handles SIGTERM/SIGINT and calls `shutdown()` on all registered services automatically.

## CatalystHonoServer

`catalystHonoServer(handler, options)` wraps any Hono app with:

- Telemetry middleware (HTTP request tracing and metrics)
- A `/health` endpoint returning `{ status: 'ok', services: [...] }`
- `Bun.serve()` binding
- Graceful shutdown on SIGTERM/SIGINT

### Options

| Option                 | Type                | Default            | Description                                    |
| :--------------------- | :------------------ | :----------------- | :--------------------------------------------- |
| `port`                 | `number`            | `3000`             | Port to listen on.                             |
| `hostname`             | `string`            | `'0.0.0.0'`        | Hostname to bind to.                           |
| `services`             | `CatalystService[]` | `[]`               | Services whose `shutdown()` is called on stop. |
| `telemetryIgnorePaths` | `string[]`          | `['/', '/health']` | Paths excluded from telemetry middleware.      |
| `websocket`            | `unknown`           | -                  | Bun WebSocket handler for RPC-over-WebSocket.  |

## Pre-built telemetry

For testing or when composing services that share a single telemetry instance, pass a pre-built `ServiceTelemetry` via `options.telemetry`. When pre-built telemetry is provided the base class skips `TelemetryBuilder.build()` and does **not** shut it down -- the caller owns the lifecycle.

```typescript
const telemetry = await new TelemetryBuilder('test').build()

const auth = await AuthService.create({ config, telemetry })
const gateway = await GatewayService.create({ config, telemetry })

// telemetry shutdown is your responsibility
```
