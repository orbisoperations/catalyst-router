# Dashboard Extraction Design

**Goal:** Extract the dashboard from the orchestrator into a standalone app (`apps/web-ui`) so the dashboard doesn't go down when the orchestrator restarts.

**Origin:** Suggestion from Jae — the orchestrator going down takes the dashboard with it. Extract it, serve the frontend independently.

## Decisions

- **Standalone app with thin backend** (not a pure static SPA). The backend proxies API calls to the orchestrator over Docker's internal network, avoiding CORS and host-URL configuration issues.
- **HTTP REST + polling** (not SSE/WebSocket). This is the Grafana standard — configurable poll intervals, no persistent connection management. Keep the existing 10s interval.
- **No peer failover** for v1. If the orchestrator is down, the dashboard shows it as unreachable. Operators can check the other node's dashboard directly.

## Architecture

```
Browser → web-ui app (port 8080) → orchestrator (port 3000)
              │                            │
              ├── serves React SPA         ├── /dashboard/api/state
              ├── /api/state (proxy)       ├── /dashboard/api/services
              ├── /api/services (proxy)    ├── /dashboard/api/config
              ├── /api/config (proxy)      │
              └── /health                  └── /health
```

The web-ui app is a thin Hono server (~50 lines) that:

1. Serves the built React SPA at `/`
2. Proxies `/api/*` to `${ORCHESTRATOR_URL}/dashboard/api/*`
3. Exposes its own `/health` endpoint

## What Moves, What Stays

| From                                        | To                        | Notes                   |
| ------------------------------------------- | ------------------------- | ----------------------- |
| `apps/orchestrator/frontend/`               | `apps/web-ui/frontend/`   | React SPA source        |
| Vite build in orchestrator Dockerfile       | `apps/web-ui/Dockerfile`  | Frontend build pipeline |
| Static file serving in `v1/service.ts`      | Removed from orchestrator | Frontend app serves it  |
| `apps/orchestrator/src/routes/dashboard.ts` | Stays in orchestrator     | Becomes internal API    |
| `CATALYST_DASHBOARD_LINKS` env var          | Stays on orchestrator     | Frontend app proxies it |

## Frontend SPA Changes

Minimal — update fetch URLs from `/dashboard/api/*` to `/api/*` since the proxy handles routing.

## Docker-Compose

```yaml
web-ui:
  build:
    context: ..
    dockerfile: apps/web-ui/Dockerfile
  ports:
    - '8080:3000'
  environment:
    - ORCHESTRATOR_URL=http://orchestrator:3000
  depends_on:
    orchestrator:
      condition: service_healthy
```

Port 8080 on the host (3050 is taken by Grafana).

## Testing

1. **Docker-compose smoke test:** Verify frontend starts healthy, API proxy returns data, orchestrator no longer serves SPA.
2. **Playwright screenshot:** Open dashboard in browser, verify it renders with real service/route/peer data.
3. **Orchestrator restart resilience:** Restart orchestrator, confirm frontend stays up and shows unreachable state (not a crash).

No unit tests — the backend is a trivial proxy with no business logic.

## Out of Scope

- SSE / WebSocket push updates
- Peer failover (connecting to alternate orchestrators)
- Dashboard authentication (existing TODO, not part of this extraction)
