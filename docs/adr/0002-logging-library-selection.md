# ADR-0002: Logging Library Selection

**Status:** Accepted
**Date:** 2026-01-26
**Decision Owner(s):** @jaeyojae @gsantiago-orbis
**Technical Story:** Select a logging library that integrates with the unified observability architecture (ADR-0001)

## Context

As part of implementing unified observability for catalyst-node (see ADR-0001), we need to select a logging library that:

1. Provides a developer-friendly API for structured logging
2. Supports automatic trace_id injection for log correlation
3. Can bridge to OpenTelemetry Logs for the unified collector approach
4. Works reliably on the Bun runtime
5. Produces structured JSON output for production

### Current State

Services currently use inconsistent logging approaches:

- `console.log` with string concatenation
- Ad-hoc JSON.stringify for structured data
- No trace correlation
- No log levels in some services

### Requirements

| Requirement            | Priority | Notes                               |
| ---------------------- | -------- | ----------------------------------- |
| Structured JSON output | Must     | For log aggregation (Loki, etc.)    |
| Developer-friendly API | Must     | Reduce friction, improve adoption   |
| Trace ID correlation   | Must     | Core to observability strategy      |
| OTEL Logs integration  | Should   | For Option 1 (unified SDK) approach |
| Bun compatibility      | Must     | Primary runtime                     |
| TypeScript support     | Must     | Type-safe logging                   |
| Low overhead           | Should   | Minimal latency impact              |

## Decision

**Chosen Option: LogTape**

We will adopt LogTape as the logging library for all catalyst-node services.

### Rationale

1. **Template Literal API** — Significantly cleaner than Pino's object-first pattern:

   ```typescript
   // LogTape - reads naturally
   logger.info`User ${userId} created order ${orderId}`

   // Pino - object first, message last
   logger.info({ userId, orderId }, 'User created order')
   ```

2. **Sink Architecture** — Perfect fit for OTEL integration:
   - Console sink for development (pretty-printed)
   - OTEL sink for production (forwards to collector)
   - Multiple sinks can run simultaneously
   - Easy to add new outputs without changing application code

3. **Hierarchical Categories** — Natural for service/component structure:

   ```typescript
   getLogger(['orchestrator', 'peering', 'handshake'])
   // Logs tagged: orchestrator.peering.handshake
   ```

4. **Trace Correlation** — OTEL sink can auto-inject trace_id:

   ```typescript
   // In the sink implementation
   const span = trace.getActiveSpan()
   const spanContext = span?.spanContext()
   // Automatically added to every log record
   ```

5. **Bun Compatibility** — Works without Node.js-specific APIs

### Trade-offs Accepted

- **Less mature** — LogTape is newer (v0.8.x) vs Pino (v8.x, 6+ years). Acceptable because we control the deployment environment.
- **Smaller ecosystem** — Fewer pre-built transports/integrations. Acceptable because our use case is well-defined (JSON + OTEL sink).
- **Less battle-tested** — Not as widely deployed in production. The API benefits outweigh ecosystem concerns.

## Consequences

### Positive

- **Cleaner code** - Template literals reduce logging boilerplate
- **Unified observability** - OTEL sink enables ADR-0001 architecture
- **Automatic correlation** - trace_id injected without developer effort
- **Flexible output** - Console in dev, OTEL in prod, same code
- **TypeScript-first** - Better type inference than Pino

### Negative

- **Learning curve** - Team familiar with Pino/Winston patterns
- **Maturity risk** - Newer library may have undiscovered issues
- **Custom sink required** - Must build and maintain OTEL sink
- **Limited tooling** - No equivalent to pino-pretty ecosystem

### Neutral

- **Performance** - Slightly slower than Pino, but acceptable (<1ms overhead)
- **Bundle size** - ~50KB vs Pino's ~15KB (acceptable for server-side)

## Implementation

### Package Structure

```
packages/telemetry/
├── src/
│   ├── logging.ts           # LogTape configuration
│   ├── logtape-otel-sink.ts # OTEL Logs bridge
│   └── index.ts             # Re-exports
```

### Usage Pattern

```typescript
// Service initialization
import { initTelemetry } from '@catalyst/telemetry'
import { initLogging, getChildLogger } from '@catalyst/telemetry/logging'

initTelemetry({ serviceName: 'orchestrator' })
initLogging('orchestrator')

// In components
const logger = getChildLogger('orchestrator', 'peering')

logger.info`Peer ${peerId} connected from ${endpoint}`
logger.debug`Handshake completed in ${durationMs}ms`
logger.error`Connection failed: ${error.message}`
```

### Migration Path

1. Add `@logtape/logtape` to workspace catalog
2. Implement OTEL sink in `@catalyst/telemetry`
3. Update services one-by-one to use new logging
4. Remove direct console.log usage

## Risks and Mitigations

| Risk                               | Likelihood | Impact | Mitigation                                 |
| ---------------------------------- | ---------- | ------ | ------------------------------------------ |
| LogTape abandoned                  | Low        | High   | Fork if needed, API is simple              |
| Performance issues at scale        | Low        | Medium | Benchmark before production                |
| OTEL sink bugs                     | Medium     | Medium | Comprehensive testing, fallback to console |
| Breaking changes in minor versions | Medium     | Low    | Pin versions, test upgrades                |

## Related Decisions

- [ADR-0001](./0001-unified-opentelemetry-observability.md) - Unified OpenTelemetry Observability

## References

- [LogTape Documentation](https://logtape.org/)
- [LogTape GitHub](https://github.com/dahlia/logtape)
- [Pino Documentation](https://getpino.io/)
- [OpenTelemetry Logs SDK](https://opentelemetry.io/docs/specs/otel/logs/)

---

## Appendix: Options Considered

<details>
<summary>Click to expand full options analysis</summary>

### Decision Drivers

- **Developer Experience** - API should feel natural, not verbose
- **Observability Integration** - Must support ADR-0001 architecture
- **Runtime Compatibility** - Must work on Bun (not just Node.js)
- **Ecosystem Maturity** - Balance between innovation and stability

### Option 1: LogTape

Modern logging library with template literal API and sink-based architecture.

**API Example:**

```typescript
import { getLogger } from '@logtape/logtape'

const logger = getLogger(['myservice', 'component'])

// Template literal API - clean and readable
logger.info`Processing request ${requestId} for user ${userId}`

// Structured properties
logger.info`Order created ${{ orderId, amount, currency }}`
```

**OTEL Integration:**

```typescript
// Custom sink bridges to OTEL Logs API
import { createOtelSink } from './logtape-otel-sink'

configure({
  sinks: {
    console: getConsoleSink(),
    otel: createOtelSink(), // Forwards to OTEL Collector
  },
  loggers: [{ category: ['myservice'], sinks: ['console', 'otel'] }],
})
```

**Characteristics:**

- Template literal API (tagged templates)
- Sink-based architecture (multiple outputs)
- Hierarchical categories (like Python logging)
- First-class TypeScript
- ~50KB bundle size
- Active development (v0.8.x)

### Option 2: Pino

Battle-tested, high-performance logging library.

**API Example:**

```typescript
import pino from 'pino'

const logger = pino({ name: 'myservice' })

// Method-based API
logger.info({ requestId, userId }, 'Processing request')

// Child loggers for context
const childLogger = logger.child({ component: 'orders' })
childLogger.info({ orderId, amount }, 'Order created')
```

**OTEL Integration:**

```typescript
// Manual trace injection required
import { trace } from '@opentelemetry/api'

function logWithTrace(logger, level, obj, msg) {
  const span = trace.getActiveSpan()
  const spanContext = span?.spanContext()

  logger[level](
    {
      ...obj,
      trace_id: spanContext?.traceId,
      span_id: spanContext?.spanId,
    },
    msg
  )
}
```

**Characteristics:**

- Fastest Node.js logger (benchmarks)
- Method-based API with object-first pattern
- Pino-pretty for development
- Large ecosystem (transports, integrations)
- ~15KB bundle size
- Mature (v8.x, 6+ years)
- No native OTEL Logs support

### Option 3: Winston

Most popular Node.js logging library.

**API Example:**

```typescript
import winston from 'winston'

const logger = winston.createLogger({
  transports: [new winston.transports.Console()],
})

logger.info('Processing request', { requestId, userId })
```

**Characteristics:**

- Transport-based architecture
- Flexible formatting
- Large ecosystem
- Higher overhead than Pino
- Complex configuration
- ~200KB bundle size

### Option 4: Console + Custom Wrapper

Build a thin wrapper around console methods.

**Characteristics:**

- Zero dependencies
- Full control
- No ecosystem benefits
- Must build everything from scratch

</details>
