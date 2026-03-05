# Catalyst SDK

## Overview

The **Catalyst SDK** (`@catalyst/sdk`) is a TypeScript-based framework designed to accelerate the development of microservices that run alongside the **Catalyst Router**. It enforces patterns for observability, API design, and service discovery.

## Features

### 1. Observability (Metrics)

The SDK provides a zero-config wrapper for pushing metrics to the **OTEL Collector Sidecar**.

- **Architecture**: OTLP Push.
- **Usage**:

  ```typescript
  import { Metric } from '@catalyst/sdk'

  // Increments a counter on the local router
  Metric.counter('http_requests_total', { status: '200' }).inc()

  // Sets a gauge
  Metric.gauge('active_connections').set(15)
  ```

### 2. GraphQL Server Pattern

The SDK includes an opinionated `createGqlServer` factory that pre-configures:

- **Apollo Server** (or compatible adapter).
- **Automatic Instrumentation**: Request duration, error rates, and field usage are automatically tracked and pushed as metrics.
- **Context Management**: Standardized context for request tracing.

```typescript
import { createGqlServer } from '@catalyst/sdk'

const server = createGqlServer({
  typeDefs,
  resolvers,
  // ...options
})
```

### 3. Service Registry (RPC)

Services automatically register themselves with the local Catalyst Router upon startup using **Cap'n Web** RPC.

- **Mechanism**: The SDK acts as an RPC Client connecting to the Orchestrator via TCP (Host: `orchestrator`, Port: `RPC_PORT`).
- **Registration**: Sends metadata (Name, Version, Port, Health Check URL) to the Router.
- **Health Checks**: The Router uses this registration to monitor the service's availability.

```typescript
import { Service } from '@catalyst/sdk'

await Service.start({
  name: 'user-service',
  port: 8080,
  onStart: () => console.log('Ready'),
})
// Automatically connects to Router RPC and calls registerService()
```
