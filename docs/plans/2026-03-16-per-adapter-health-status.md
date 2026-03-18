# Per-Adapter Health Status

**Date:** 2026-03-16
**Author:** Ian Hammerstrom

## What This Does

Adds health status visibility for all adapters (data channels) across the Catalyst mesh. Each node probes its own local adapters' /health endpoints and propagates status changes to peers via iBGP.

## Architecture

### Health Checking

A new AdapterHealthChecker in the v2 orchestrator periodically hits GET {baseUrl}/health on each local adapter (configurable interval, default 30s). Three states: Up (2xx), Down (was up, now fails), Unknown (never responded).

### iBGP Propagation

A new LocalRouteHealthUpdate RIB action updates health fields on an existing local route. Dispatched only on status changes (up to down, down to up) to prevent iBGP churn. Flows through existing dispatch pipeline to connected peers.

### Frontend

Adapters tab updated from card list to table layout (inspired by Figma data channels design). Columns: Data channel, Protocol, Endpoint, Origin, Status badge, Response ms.

## Configuration

| Field      | Env Var                             | Default |
| ---------- | ----------------------------------- | ------- |
| enabled    | CATALYST_ADAPTER_HEALTH_ENABLED     | true    |
| intervalMs | CATALYST_ADAPTER_HEALTH_INTERVAL_MS | 30000   |
| timeoutMs  | CATALYST_ADAPTER_HEALTH_TIMEOUT_MS  | 3000    |

## References

- Figma: https://www.figma.com/proto/2d7KnSbZY1QplKLS95dEuN/Catalyst-Designs-V1.0?node-id=6515-959
- ADR-0015: Cedar authorization (auth for /api/state is a known gap)
