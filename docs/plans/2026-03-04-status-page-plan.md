# Status Page Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build `apps/status-page` — a standalone Hono + React/Vite dashboard that queries Prometheus, Jaeger, and InfluxDB to show per-container health, logs, metrics, and traces for each Catalyst node.

**Architecture:** A new app following the existing CatalystService pattern (Hono backend on :4040), with a React SPA frontend built via Vite and served as static files. The backend proxies API requests to the three observability backends. OTEL collector config is updated to export to those backends, and the backends are added to docker-compose.

**Tech Stack:** Hono, React 19, Vite, TypeScript, @catalyst/service, @catalyst/config, @catalyst/telemetry, Prometheus API, Jaeger API, InfluxDB API

---

## Phase 1: Infrastructure — Observability Backends

### Task 1: Update OTEL Collector Config

**Files:**

- Modify: `docker-compose/otel-collector-config.yaml`

**Step 1: Add exporters for Prometheus, Jaeger, and InfluxDB**

```yaml
# docker-compose/otel-collector-config.yaml
extensions:
  health_check:
    endpoint: 0.0.0.0:13133

receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch:
  memory_limiter:
    check_interval: 5s
    limit_mib: 256

exporters:
  debug:
    verbosity: detailed
  otlphttp/jaeger:
    endpoint: http://jaeger:4318
  prometheusremotewrite:
    endpoint: http://prometheus:9090/api/v1/write
  otlphttp/logs:
    endpoint: http://influxdb:4318

service:
  extensions: [health_check]
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [debug, otlphttp/jaeger]
    metrics:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [debug, prometheusremotewrite]
    logs:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [debug, otlphttp/logs]
```

> **Note:** InfluxDB 2.x can receive OTLP natively via its built-in collector endpoint. If that doesn't work, we may need to switch to the `influxdb` exporter from otel-collector-contrib. Verify during testing.

**Step 2: Commit**

```bash
gt commit create -m "chore: configure OTEL collector to export to Prometheus, Jaeger, InfluxDB"
```

---

### Task 2: Add Observability Backend Services to Docker Compose

**Files:**

- Modify: `docker-compose/two-node.compose.yaml`

**Step 1: Add Prometheus, Jaeger, InfluxDB, and status-page services**

Add these services after the `otel-collector` service block:

```yaml
# --- Observability backends ---

prometheus:
  image: prom/prometheus:v3.2.1
  ports:
    - '9090:9090'
  volumes:
    - ./prometheus.yaml:/etc/prometheus/prometheus.yml:ro
    - prometheus-data:/prometheus
  command:
    - '--config.file=/etc/prometheus/prometheus.yml'
    - '--web.enable-remote-write-receiver'
    - '--storage.tsdb.retention.time=7d'
  depends_on:
    otel-collector:
      condition: service_started

jaeger:
  image: jaegertracing/jaeger:2.5.0
  ports:
    - '16686:16686'
  environment:
    - COLLECTOR_OTLP_ENABLED=true
  depends_on:
    otel-collector:
      condition: service_started

influxdb:
  image: influxdb:2.7-alpine
  ports:
    - '8086:8086'
  environment:
    - DOCKER_INFLUXDB_INIT_MODE=setup
    - DOCKER_INFLUXDB_INIT_USERNAME=admin
    - DOCKER_INFLUXDB_INIT_PASSWORD=catalyst-dev
    - DOCKER_INFLUXDB_INIT_ORG=catalyst
    - DOCKER_INFLUXDB_INIT_BUCKET=logs
    - DOCKER_INFLUXDB_INIT_ADMIN_TOKEN=catalyst-dev-token
  volumes:
    - influxdb-data:/var/lib/influxdb2
```

Add to the `volumes:` section at the bottom:

```yaml
prometheus-data:
influxdb-data:
```

**Step 2: Create minimal Prometheus config**

Create `docker-compose/prometheus.yaml`:

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s
```

**Step 3: Verify backends start**

```bash
docker compose -f docker-compose/two-node.compose.yaml up prometheus jaeger influxdb otel-collector -d
```

Expected: All 4 containers start and stay healthy. Prometheus UI at http://localhost:9090, Jaeger UI at http://localhost:16686, InfluxDB UI at http://localhost:8086.

**Step 4: Commit**

```bash
gt commit create -m "infra: add Prometheus, Jaeger, InfluxDB to two-node compose"
```

---

## Phase 2: App Scaffold — Backend Only

### Task 3: Create `apps/status-page` Package Scaffold

**Files:**

- Create: `apps/status-page/package.json`
- Create: `apps/status-page/tsconfig.json`

**Step 1: Create `package.json`**

```json
{
  "name": "@catalyst/status-page-service",
  "version": "0.0.0",
  "type": "module",
  "private": true,
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:unit": "vitest run --exclude '**/*{integration,container}*' --passWithNoTests",
    "test:integration": "vitest run --passWithNoTests container integration"
  },
  "dependencies": {
    "hono": "catalog:",
    "@catalyst/config": "workspace:*",
    "@catalyst/service": "workspace:*",
    "@catalyst/telemetry": "workspace:*",
    "@opentelemetry/api": "catalog:"
  },
  "devDependencies": {
    "@hono/node-server": "catalog:",
    "@hono/node-ws": "catalog:",
    "@types/node": "catalog:dev",
    "typescript": "catalog:dev",
    "vitest": "catalog:testing"
  }
}
```

**Step 2: Create `tsconfig.json`**

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": ".",
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src/**/*", "tests/**/*"]
}
```

**Step 3: Install dependencies**

```bash
pnpm install
```

**Step 4: Commit**

```bash
gt commit create -m "chore: scaffold apps/status-page package"
```

---

### Task 4: Create StatusPageService and Entry Point

**Files:**

- Create: `apps/status-page/src/service.ts`
- Create: `apps/status-page/src/index.ts`

**Step 1: Create `src/service.ts`**

```ts
import { Hono } from 'hono'
import { CatalystService } from '@catalyst/service'
import type { CatalystServiceOptions } from '@catalyst/service'

export interface StatusPageConfig {
  prometheusUrl: string
  jaegerUrl: string
  influxdbUrl: string
}

function loadStatusPageConfig(): StatusPageConfig {
  return {
    prometheusUrl: process.env.PROMETHEUS_URL ?? 'http://prometheus:9090',
    jaegerUrl: process.env.JAEGER_URL ?? 'http://jaeger:16686',
    influxdbUrl: process.env.INFLUXDB_URL ?? 'http://influxdb:8086',
  }
}

export class StatusPageService extends CatalystService {
  readonly info = { name: 'status-page', version: '0.0.0' }
  readonly handler = new Hono()
  readonly backends: StatusPageConfig

  constructor(options: CatalystServiceOptions) {
    super(options)
    this.backends = loadStatusPageConfig()
  }

  protected async onInitialize(): Promise<void> {
    this.handler.get('/', (c) => c.text('Catalyst Status Page'))

    this.handler.get('/api/status', (c) =>
      c.json({
        backends: {
          prometheus: this.backends.prometheusUrl,
          jaeger: this.backends.jaegerUrl,
          influxdb: this.backends.influxdbUrl,
        },
      })
    )

    this.telemetry.logger.info`StatusPageService initialized`
  }
}
```

**Step 2: Create `src/index.ts`**

```ts
import { loadDefaultConfig } from '@catalyst/config'
import { catalystHonoServer } from '@catalyst/service'
import { StatusPageService } from './service.js'

const config = loadDefaultConfig({ serviceType: 'gateway' })
const statusPage = await StatusPageService.create({ config })

catalystHonoServer(statusPage.handler, {
  services: [statusPage],
  port: config.port,
}).start()
```

> **Note:** `serviceType: 'gateway'` is used to skip the `CATALYST_PEERING_ENDPOINT` requirement. The status page is not an orchestrator.

**Step 3: Verify it starts locally**

```bash
CATALYST_NODE_ID=status-page.local PORT=4040 pnpm --filter @catalyst/status-page-service dev
```

Expected: Server starts, `GET /health` returns `{"status":"ok"}`, `GET /api/status` returns backend URLs.

**Step 4: Commit**

```bash
gt commit create -m "feat: add StatusPageService with health and status endpoints"
```

---

### Task 5: Add Backend Proxy Routes

**Files:**

- Create: `apps/status-page/src/routes/metrics.ts`
- Create: `apps/status-page/src/routes/traces.ts`
- Create: `apps/status-page/src/routes/logs.ts`
- Modify: `apps/status-page/src/service.ts`

**Step 1: Create `src/routes/metrics.ts`** — Prometheus proxy

```ts
import { Hono } from 'hono'

export function createMetricsRoutes(prometheusUrl: string): Hono {
  const app = new Hono()

  // Proxy PromQL instant queries
  app.get('/query', async (c) => {
    const query = c.req.query('query')
    if (!query) return c.json({ error: 'query parameter required' }, 400)

    const url = new URL('/api/v1/query', prometheusUrl)
    url.searchParams.set('query', query)
    const time = c.req.query('time')
    if (time) url.searchParams.set('time', time)

    const res = await fetch(url)
    return c.json(await res.json(), res.status as 200)
  })

  // Proxy PromQL range queries
  app.get('/query_range', async (c) => {
    const params = ['query', 'start', 'end', 'step']
    const url = new URL('/api/v1/query_range', prometheusUrl)
    for (const p of params) {
      const v = c.req.query(p)
      if (v) url.searchParams.set(p, v)
    }

    const res = await fetch(url)
    return c.json(await res.json(), res.status as 200)
  })

  // Proxy label values (for autocomplete)
  app.get('/label/:name/values', async (c) => {
    const url = new URL(`/api/v1/label/${c.req.param('name')}/values`, prometheusUrl)
    const res = await fetch(url)
    return c.json(await res.json(), res.status as 200)
  })

  return app
}
```

**Step 2: Create `src/routes/traces.ts`** — Jaeger proxy

```ts
import { Hono } from 'hono'

export function createTracesRoutes(jaegerUrl: string): Hono {
  const app = new Hono()

  // List services
  app.get('/services', async (c) => {
    const res = await fetch(new URL('/api/services', jaegerUrl))
    return c.json(await res.json(), res.status as 200)
  })

  // Search traces
  app.get('/traces', async (c) => {
    const url = new URL('/api/traces', jaegerUrl)
    for (const [k, v] of Object.entries(c.req.query())) {
      url.searchParams.set(k, v as string)
    }
    const res = await fetch(url)
    return c.json(await res.json(), res.status as 200)
  })

  // Get single trace
  app.get('/traces/:traceId', async (c) => {
    const res = await fetch(new URL(`/api/traces/${c.req.param('traceId')}`, jaegerUrl))
    return c.json(await res.json(), res.status as 200)
  })

  return app
}
```

**Step 3: Create `src/routes/logs.ts`** — InfluxDB proxy

```ts
import { Hono } from 'hono'

export function createLogsRoutes(influxdbUrl: string): Hono {
  const app = new Hono()

  // Query logs via Flux
  app.post('/query', async (c) => {
    const body = await c.req.json()
    const token = process.env.INFLUXDB_TOKEN ?? 'catalyst-dev-token'

    const res = await fetch(new URL('/api/v2/query?org=catalyst', influxdbUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Token ${token}`,
        Accept: 'application/json',
      },
      body: JSON.stringify({
        query: body.query,
        type: 'flux',
      }),
    })

    const text = await res.text()
    return c.text(text, res.status as 200)
  })

  return app
}
```

**Step 4: Mount routes in service**

Add to `src/service.ts` in `onInitialize()`:

```ts
import { createMetricsRoutes } from './routes/metrics.js'
import { createTracesRoutes } from './routes/traces.js'
import { createLogsRoutes } from './routes/logs.js'
```

In `onInitialize()`, after the existing routes:

```ts
this.handler.route('/api/metrics', createMetricsRoutes(this.backends.prometheusUrl))
this.handler.route('/api/traces', createTracesRoutes(this.backends.jaegerUrl))
this.handler.route('/api/logs', createLogsRoutes(this.backends.influxdbUrl))
```

**Step 5: Commit**

```bash
gt commit create -m "feat: add proxy routes for Prometheus, Jaeger, InfluxDB"
```

---

### Task 6: Create Dockerfile

**Files:**

- Create: `apps/status-page/Dockerfile`
- Modify: root `package.json` (add compile script)

**Step 1: Create Dockerfile**

Follow the gateway pattern exactly. The Dockerfile copies all workspace manifests (including any new ones for status-page), installs deps, bundles with esbuild, and creates a minimal runtime image.

```dockerfile
# Build from repo root: docker build -f apps/status-page/Dockerfile -t catalyst-status-page .
FROM node:22-alpine AS build
WORKDIR /app

RUN corepack enable

# Copy workspace manifests for dependency caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/auth/package.json apps/auth/
COPY apps/cli/package.json apps/cli/
COPY apps/envoy/package.json apps/envoy/
COPY apps/gateway/package.json apps/gateway/
COPY apps/node/package.json apps/node/
COPY apps/orchestrator/package.json apps/orchestrator/
COPY apps/status-page/package.json apps/status-page/
COPY packages/authorization/package.json packages/authorization/
COPY packages/config/package.json packages/config/
COPY packages/routing/package.json packages/routing/
COPY packages/sdk/package.json packages/sdk/
COPY packages/telemetry/package.json packages/telemetry/
COPY packages/types/package.json packages/types/
COPY packages/service/package.json packages/service/
COPY examples/books-api/package.json examples/books-api/
COPY examples/movies-api/package.json examples/movies-api/
COPY examples/orders-api/package.json examples/orders-api/
COPY examples/product-api/package.json examples/product-api/

# Install all dependencies
RUN pnpm install --frozen-lockfile

# Copy app source and workspace dependencies
COPY apps/status-page apps/status-page
COPY packages/telemetry packages/telemetry
COPY packages/service packages/service
COPY packages/config packages/config

# Bundle with esbuild
RUN pnpm exec esbuild apps/status-page/src/index.ts \
  --bundle --platform=node --target=node22 \
  --outfile=dist/server.mjs --format=esm \
  --banner:js='import{createRequire}from"module";import{fileURLToPath as __file}from"url";import{dirname as __dir}from"path";const require=createRequire(import.meta.url),__filename=__file(import.meta.url),__dirname=__dir(__filename);'

# Create production deployment
RUN pnpm deploy --filter=@catalyst/status-page-service --prod /deploy

# Runtime stage
FROM node:22-alpine
WORKDIR /app

COPY --from=build /deploy/node_modules ./node_modules
COPY --from=build /app/dist/server.mjs ./server.mjs

ENV PORT=4040
EXPOSE 4040

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

CMD ["node", "server.mjs"]
```

**Step 2: Add compile script to root `package.json`**

Add to `scripts`:

```json
"compile:status-page:docker": "docker build -f apps/status-page/Dockerfile -t catalyst-status-page ."
```

Update `compile:all:docker` to include it.

**Step 3: Add status-page service to docker-compose**

Add to `docker-compose/two-node.compose.yaml`:

```yaml
# --- Status Page ---

status-page:
  build:
    context: ..
    dockerfile: apps/status-page/Dockerfile
  ports:
    - '4040:4040'
  environment:
    - PORT=4040
    - CATALYST_NODE_ID=status-page.somebiz.local.io
    - PROMETHEUS_URL=http://prometheus:9090
    - JAEGER_URL=http://jaeger:16686
    - INFLUXDB_URL=http://influxdb:8086
    - OTEL_SERVICE_NAME=status-page
    - OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
  healthcheck:
    test: ['CMD', 'wget', '--no-verbose', '--tries=1', '--spider', 'http://127.0.0.1:4040/health']
    interval: 10s
    timeout: 5s
    retries: 5
  depends_on:
    otel-collector:
      condition: service_started
    prometheus:
      condition: service_started
    jaeger:
      condition: service_started
    influxdb:
      condition: service_started
```

**Step 4: Build and verify container starts**

```bash
docker compose -f docker-compose/two-node.compose.yaml build status-page
docker compose -f docker-compose/two-node.compose.yaml up status-page -d
curl http://localhost:4040/health
```

Expected: `{"status":"ok","services":["status-page"]}`

**Step 5: Commit**

```bash
gt commit create -m "feat: add Dockerfile and docker-compose for status-page"
```

---

## Phase 3: React Frontend

### Task 7: Add Vite + React to the Status Page

**Files:**

- Create: `apps/status-page/frontend/index.html`
- Create: `apps/status-page/frontend/src/main.tsx`
- Create: `apps/status-page/frontend/src/App.tsx`
- Create: `apps/status-page/frontend/vite.config.ts`
- Create: `apps/status-page/frontend/tsconfig.json`
- Modify: `apps/status-page/package.json` (add React deps + build scripts)

**Step 1: Add frontend dependencies to `package.json`**

Add to `dependencies`:

```json
"react": "^19.0.0",
"react-dom": "^19.0.0"
```

Add to `devDependencies`:

```json
"@types/react": "^19.0.0",
"@types/react-dom": "^19.0.0",
"@vitejs/plugin-react": "^4.3.0",
"vite": "^6.0.0"
```

Add scripts:

```json
"build:frontend": "vite build --config frontend/vite.config.ts",
"dev:frontend": "vite --config frontend/vite.config.ts"
```

**Step 2: Create `frontend/vite.config.ts`**

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  root: './frontend',
  build: {
    outDir: '../dist/frontend',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:4040',
    },
  },
})
```

**Step 3: Create `frontend/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["vite/client"]
  },
  "include": ["src"]
}
```

**Step 4: Create `frontend/index.html`**

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Catalyst Status</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

**Step 5: Create `frontend/src/main.tsx`**

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
```

**Step 6: Create `frontend/src/App.tsx`**

```tsx
import { useState } from 'react'

type Tab = 'nodes' | 'adapters'

export function App() {
  const [tab, setTab] = useState<Tab>('nodes')

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: '1rem' }}>
      <h1>Catalyst Status</h1>
      <nav style={{ display: 'flex', gap: '1rem', marginBottom: '1rem' }}>
        <button
          onClick={() => setTab('nodes')}
          style={{ fontWeight: tab === 'nodes' ? 'bold' : 'normal' }}
        >
          Nodes
        </button>
        <button
          onClick={() => setTab('adapters')}
          style={{ fontWeight: tab === 'adapters' ? 'bold' : 'normal' }}
        >
          Adapters
        </button>
      </nav>
      {tab === 'nodes' ? <NodesTab /> : <AdaptersPlaceholder />}
    </div>
  )
}

function NodesTab() {
  return (
    <div>
      <h2>Node Services</h2>
      <p>Health, logs, metrics, and traces for each Catalyst service.</p>
      {/* ServiceCard components will go here in Task 8 */}
    </div>
  )
}

function AdaptersPlaceholder() {
  return (
    <div>
      <h2>Adapters</h2>
      <p>Coming soon — per-adapter observability.</p>
    </div>
  )
}
```

**Step 7: Verify frontend dev server works**

```bash
cd apps/status-page && pnpm dev:frontend
```

Expected: Vite dev server at http://localhost:5173, shows "Catalyst Status" with two tabs.

**Step 8: Commit**

```bash
gt commit create -m "feat: add React + Vite frontend scaffold with tab navigation"
```

---

### Task 8: Serve Frontend from Hono Backend

**Files:**

- Modify: `apps/status-page/src/service.ts`
- Modify: `apps/status-page/Dockerfile`

**Step 1: Add static file serving to `service.ts`**

Add import and route at the end of `onInitialize()`:

```ts
import { serveStatic } from '@hono/node-server/serve-static'
import path from 'node:path'
```

At the end of `onInitialize()`:

```ts
// Serve frontend static files (built by Vite)
const frontendDir = path.resolve(import.meta.dirname ?? '.', 'frontend')
this.handler.use('/*', serveStatic({ root: frontendDir }))
// SPA fallback — serve index.html for all unmatched routes
this.handler.get('/*', serveStatic({ root: frontendDir, path: 'index.html' }))
```

> **Note:** In the Docker container, `import.meta.dirname` won't be available since we use esbuild bundling. We'll need to adjust for the container path — the built frontend files will be at `/app/frontend/`. The `serveStatic` root will need to be an absolute path or relative to CWD.

**Step 2: Update Dockerfile to build and include frontend**

In the build stage, after copying source and before esbuild:

```dockerfile
# Build frontend
RUN cd apps/status-page && pnpm exec vite build --config frontend/vite.config.ts
```

In the runtime stage, after copying server.mjs:

```dockerfile
COPY --from=build /app/apps/status-page/dist/frontend ./frontend
```

Update the static file path in service.ts to use a path that works in both dev and container:

```ts
const frontendDir = process.env.FRONTEND_DIR ?? path.join(process.cwd(), 'frontend')
```

Add to Dockerfile environment:

```dockerfile
ENV FRONTEND_DIR=/app/frontend
```

**Step 3: Build and test**

```bash
cd apps/status-page && pnpm build:frontend
CATALYST_NODE_ID=test PORT=4040 FRONTEND_DIR=dist/frontend pnpm dev
```

Expected: http://localhost:4040 shows the React app, http://localhost:4040/api/status returns JSON.

**Step 4: Commit**

```bash
gt commit create -m "feat: serve Vite-built frontend from Hono backend"
```

---

### Task 9: Build the Nodes Tab — Service Health Cards

**Files:**

- Create: `apps/status-page/frontend/src/components/ServiceCard.tsx`
- Create: `apps/status-page/frontend/src/hooks/useHealth.ts`
- Modify: `apps/status-page/frontend/src/App.tsx`
- Create: `apps/status-page/src/routes/health.ts`
- Modify: `apps/status-page/src/service.ts`

**Step 1: Create health aggregation route on backend**

Create `src/routes/health.ts`:

```ts
import { Hono } from 'hono'

interface ServiceHealth {
  name: string
  url: string
  status: 'up' | 'down' | 'unknown'
  latencyMs?: number
  error?: string
}

const SERVICES = [
  { name: 'orchestrator-a', url: 'http://node-a:3000/health' },
  { name: 'orchestrator-b', url: 'http://node-b:3000/health' },
  { name: 'gateway-a', url: 'http://gateway-a:4000/health' },
  { name: 'gateway-b', url: 'http://gateway-b:4000/health' },
  { name: 'auth', url: 'http://auth:4020/health' },
  { name: 'envoy-service', url: 'http://envoy-service:3000/health' },
]

async function checkHealth(service: { name: string; url: string }): Promise<ServiceHealth> {
  const start = performance.now()
  try {
    const res = await fetch(service.url, { signal: AbortSignal.timeout(3000) })
    return {
      name: service.name,
      url: service.url,
      status: res.ok ? 'up' : 'down',
      latencyMs: Math.round(performance.now() - start),
    }
  } catch (err) {
    return {
      name: service.name,
      url: service.url,
      status: 'down',
      latencyMs: Math.round(performance.now() - start),
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export function createHealthRoutes(): Hono {
  const app = new Hono()

  app.get('/', async (c) => {
    const results = await Promise.all(SERVICES.map(checkHealth))
    return c.json({ services: results })
  })

  return app
}
```

Mount in `service.ts`:

```ts
import { createHealthRoutes } from './routes/health.js'
// ...
this.handler.route('/api/services', createHealthRoutes())
```

**Step 2: Create `frontend/src/hooks/useHealth.ts`**

```tsx
import { useState, useEffect } from 'react'

interface ServiceHealth {
  name: string
  url: string
  status: 'up' | 'down' | 'unknown'
  latencyMs?: number
  error?: string
}

export function useHealth(pollIntervalMs = 10000) {
  const [services, setServices] = useState<ServiceHealth[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    const fetchHealth = async () => {
      try {
        const res = await fetch('/api/services')
        const data = await res.json()
        if (active) {
          setServices(data.services)
          setLoading(false)
        }
      } catch {
        if (active) setLoading(false)
      }
    }

    fetchHealth()
    const interval = setInterval(fetchHealth, pollIntervalMs)
    return () => {
      active = false
      clearInterval(interval)
    }
  }, [pollIntervalMs])

  return { services, loading }
}
```

**Step 3: Create `frontend/src/components/ServiceCard.tsx`**

```tsx
interface ServiceHealth {
  name: string
  status: 'up' | 'down' | 'unknown'
  latencyMs?: number
  error?: string
}

export function ServiceCard({ service }: { service: ServiceHealth }) {
  const statusColor =
    service.status === 'up' ? '#22c55e' : service.status === 'down' ? '#ef4444' : '#94a3b8'

  return (
    <div
      style={{
        border: '1px solid #e2e8f0',
        borderRadius: '8px',
        padding: '1rem',
        marginBottom: '0.5rem',
        display: 'flex',
        alignItems: 'center',
        gap: '0.75rem',
      }}
    >
      <div
        style={{
          width: '12px',
          height: '12px',
          borderRadius: '50%',
          backgroundColor: statusColor,
        }}
      />
      <div style={{ flex: 1 }}>
        <strong>{service.name}</strong>
        {service.latencyMs !== undefined && (
          <span style={{ color: '#64748b', marginLeft: '0.5rem', fontSize: '0.875rem' }}>
            {service.latencyMs}ms
          </span>
        )}
      </div>
      <span
        style={{
          color: statusColor,
          fontWeight: 600,
          textTransform: 'uppercase',
          fontSize: '0.75rem',
        }}
      >
        {service.status}
      </span>
    </div>
  )
}
```

**Step 4: Update `App.tsx` NodesTab**

```tsx
import { useHealth } from './hooks/useHealth'
import { ServiceCard } from './components/ServiceCard'

function NodesTab() {
  const { services, loading } = useHealth()

  if (loading) return <p>Loading...</p>

  return (
    <div>
      <h2>Node Services</h2>
      {services.map((s) => (
        <ServiceCard key={s.name} service={s} />
      ))}
    </div>
  )
}
```

**Step 5: Commit**

```bash
gt commit create -m "feat: add service health cards with auto-polling"
```

---

### Task 10: Add Metrics Charts (Prometheus)

**Files:**

- Create: `apps/status-page/frontend/src/components/MetricsChart.tsx`
- Create: `apps/status-page/frontend/src/hooks/useMetrics.ts`
- Modify: `apps/status-page/frontend/src/components/ServiceCard.tsx`

This task adds request rate and error rate time-series charts per service. Use a lightweight charting approach — either a thin canvas wrapper or a small library. For MVP, use inline SVG sparklines to avoid adding a heavy charting dependency.

**Step 1: Create `frontend/src/hooks/useMetrics.ts`**

```tsx
import { useState, useEffect } from 'react'

interface MetricPoint {
  timestamp: number
  value: number
}

export function useMetrics(query: string, pollIntervalMs = 15000) {
  const [data, setData] = useState<MetricPoint[]>([])

  useEffect(() => {
    let active = true
    const fetchMetrics = async () => {
      const end = Math.floor(Date.now() / 1000)
      const start = end - 3600 // last hour
      const params = new URLSearchParams({
        query,
        start: String(start),
        end: String(end),
        step: '60',
      })

      try {
        const res = await fetch(`/api/metrics/query_range?${params}`)
        const json = await res.json()
        if (active && json.data?.result?.[0]?.values) {
          setData(
            json.data.result[0].values.map(([t, v]: [number, string]) => ({
              timestamp: t,
              value: parseFloat(v),
            }))
          )
        }
      } catch {
        /* ignore fetch errors */
      }
    }

    fetchMetrics()
    const interval = setInterval(fetchMetrics, pollIntervalMs)
    return () => {
      active = false
      clearInterval(interval)
    }
  }, [query, pollIntervalMs])

  return data
}
```

**Step 2: Create `frontend/src/components/MetricsChart.tsx`**

A minimal SVG sparkline component:

```tsx
interface MetricPoint {
  timestamp: number
  value: number
}

export function Sparkline({
  data,
  color = '#3b82f6',
  width = 200,
  height = 40,
}: {
  data: MetricPoint[]
  color?: string
  width?: number
  height?: number
}) {
  if (data.length < 2) return <span style={{ color: '#94a3b8', fontSize: '0.75rem' }}>No data</span>

  const values = data.map((d) => d.value)
  const max = Math.max(...values, 1)
  const min = Math.min(...values, 0)
  const range = max - min || 1

  const points = data
    .map((d, i) => {
      const x = (i / (data.length - 1)) * width
      const y = height - ((d.value - min) / range) * height
      return `${x},${y}`
    })
    .join(' ')

  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      <polyline fill="none" stroke={color} strokeWidth="1.5" points={points} />
    </svg>
  )
}
```

**Step 3: Wire metrics into ServiceCard**

Expand ServiceCard to show request rate and error rate sparklines beneath the health indicator. Use PromQL queries like:

- Request rate: `rate(http_server_request_duration_seconds_count{service_name="<name>"}[5m])`
- Error rate: `rate(http_server_request_duration_seconds_count{service_name="<name>",http_response_status_code=~"5.."}[5m])`

**Step 4: Commit**

```bash
gt commit create -m "feat: add Prometheus metrics sparklines to service cards"
```

---

### Task 11: Add Log Stream (InfluxDB)

**Files:**

- Create: `apps/status-page/frontend/src/components/LogStream.tsx`
- Create: `apps/status-page/frontend/src/hooks/useLogs.ts`

This task adds a log tail view per service. Queries InfluxDB for recent log entries filtered by service name.

**Step 1: Create `frontend/src/hooks/useLogs.ts`**

```tsx
import { useState, useEffect } from 'react'

interface LogEntry {
  timestamp: string
  severity: string
  body: string
  attributes: Record<string, string>
}

export function useLogs(serviceName: string, limit = 50, pollIntervalMs = 5000) {
  const [logs, setLogs] = useState<LogEntry[]>([])

  useEffect(() => {
    let active = true
    const fetchLogs = async () => {
      const query = `from(bucket: "logs")
        |> range(start: -1h)
        |> filter(fn: (r) => r["service.name"] == "${serviceName}")
        |> sort(columns: ["_time"], desc: true)
        |> limit(n: ${limit})`

      try {
        const res = await fetch('/api/logs/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query }),
        })
        const text = await res.text()
        if (active) {
          // Parse InfluxDB CSV response into log entries
          // This will need refinement based on actual InfluxDB response format
          setLogs(parseInfluxResponse(text))
        }
      } catch {
        /* ignore */
      }
    }

    fetchLogs()
    const interval = setInterval(fetchLogs, pollIntervalMs)
    return () => {
      active = false
      clearInterval(interval)
    }
  }, [serviceName, limit, pollIntervalMs])

  return logs
}

function parseInfluxResponse(csv: string): LogEntry[] {
  // InfluxDB returns annotated CSV. Parse rows into LogEntry objects.
  // This is a simplified parser — adjust based on actual response format.
  const lines = csv.split('\n').filter((l) => l && !l.startsWith('#') && !l.startsWith(','))
  return lines.slice(0, 50).map((line) => {
    const parts = line.split(',')
    return {
      timestamp: parts[5] ?? '',
      severity: parts[6] ?? 'INFO',
      body: parts[7] ?? line,
      attributes: {},
    }
  })
}
```

**Step 2: Create `frontend/src/components/LogStream.tsx`**

```tsx
interface LogEntry {
  timestamp: string
  severity: string
  body: string
}

const SEVERITY_COLORS: Record<string, string> = {
  ERROR: '#ef4444',
  WARN: '#f59e0b',
  INFO: '#3b82f6',
  DEBUG: '#94a3b8',
}

export function LogStream({ logs }: { logs: LogEntry[] }) {
  if (logs.length === 0) return <p style={{ color: '#94a3b8' }}>No logs yet</p>

  return (
    <div
      style={{
        fontFamily: 'monospace',
        fontSize: '0.75rem',
        maxHeight: '300px',
        overflowY: 'auto',
        backgroundColor: '#0f172a',
        color: '#e2e8f0',
        padding: '0.5rem',
        borderRadius: '4px',
      }}
    >
      {logs.map((log, i) => (
        <div key={i} style={{ marginBottom: '2px' }}>
          <span style={{ color: '#64748b' }}>{log.timestamp}</span>{' '}
          <span style={{ color: SEVERITY_COLORS[log.severity] ?? '#94a3b8' }}>{log.severity}</span>{' '}
          {log.body}
        </div>
      ))}
    </div>
  )
}
```

**Step 3: Commit**

```bash
gt commit create -m "feat: add log stream component with InfluxDB polling"
```

---

### Task 12: Add Trace Explorer (Jaeger)

**Files:**

- Create: `apps/status-page/frontend/src/components/TraceList.tsx`
- Create: `apps/status-page/frontend/src/hooks/useTraces.ts`

This task adds a trace list per service showing recent traces with their duration and status.

**Step 1: Create `frontend/src/hooks/useTraces.ts`**

```tsx
import { useState, useEffect } from 'react'

interface Trace {
  traceID: string
  spans: Array<{
    operationName: string
    duration: number
    tags: Array<{ key: string; value: string }>
  }>
  duration: number
}

export function useTraces(serviceName: string, limit = 20, pollIntervalMs = 10000) {
  const [traces, setTraces] = useState<Trace[]>([])

  useEffect(() => {
    let active = true
    const fetchTraces = async () => {
      const params = new URLSearchParams({
        service: serviceName,
        limit: String(limit),
        lookback: '1h',
      })

      try {
        const res = await fetch(`/api/traces/traces?${params}`)
        const json = await res.json()
        if (active && json.data) {
          setTraces(json.data)
        }
      } catch {
        /* ignore */
      }
    }

    fetchTraces()
    const interval = setInterval(fetchTraces, pollIntervalMs)
    return () => {
      active = false
      clearInterval(interval)
    }
  }, [serviceName, limit, pollIntervalMs])

  return traces
}
```

**Step 2: Create `frontend/src/components/TraceList.tsx`**

```tsx
interface Trace {
  traceID: string
  spans: Array<{
    operationName: string
    duration: number
  }>
  duration: number
}

export function TraceList({ traces }: { traces: Trace[] }) {
  if (traces.length === 0) return <p style={{ color: '#94a3b8' }}>No traces yet</p>

  return (
    <div style={{ fontSize: '0.875rem' }}>
      {traces.map((trace) => (
        <div
          key={trace.traceID}
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            padding: '0.25rem 0',
            borderBottom: '1px solid #f1f5f9',
          }}
        >
          <span style={{ fontFamily: 'monospace', fontSize: '0.75rem', color: '#64748b' }}>
            {trace.traceID.slice(0, 8)}
          </span>
          <span>{trace.spans[0]?.operationName ?? '(unknown)'}</span>
          <span style={{ color: '#64748b' }}>{trace.spans.length} spans</span>
          <span style={{ fontFamily: 'monospace' }}>{(trace.duration / 1000).toFixed(1)}ms</span>
        </div>
      ))}
    </div>
  )
}
```

**Step 3: Commit**

```bash
gt commit create -m "feat: add trace explorer with Jaeger integration"
```

---

### Task 13: Wire Everything Together in the Nodes Tab

**Files:**

- Modify: `apps/status-page/frontend/src/App.tsx`
- Modify: `apps/status-page/frontend/src/components/ServiceCard.tsx`

**Step 1: Create an expanded ServiceCard with tabs**

Update ServiceCard to be expandable — click a service to see its logs, metrics, and traces in sub-panels. The collapsed view shows health status + sparklines. The expanded view adds log stream + trace list.

**Step 2: Integration test**

```bash
docker compose -f docker-compose/two-node.compose.yaml up --build -d
curl http://localhost:4040/health
curl http://localhost:4040/api/services
```

Open http://localhost:4040 — verify:

- Two tabs (Nodes / Adapters)
- Service cards with health status
- Sparkline metrics (if Prometheus has data)
- Log stream (if InfluxDB has data)
- Trace list (if Jaeger has data)

**Step 3: Commit**

```bash
gt commit create -m "feat: complete nodes tab with health, logs, metrics, traces"
```

---

## Phase 4: Polish & Integrate

### Task 14: Update Other Dockerfiles

**Files:**

- Modify: All `apps/*/Dockerfile` files
- Modify: `Dockerfile.base` (if it exists and is used)
- Modify: `docker-bake.hcl`

Each Dockerfile copies all workspace `package.json` manifests. Add the new status-page manifest line to each:

```dockerfile
COPY apps/status-page/package.json apps/status-page/
```

This is required so that `pnpm install --frozen-lockfile` succeeds in any Dockerfile.

Also add `status-page` target to `docker-bake.hcl`.

**Step 1: Commit**

```bash
gt commit create -m "chore: add status-page manifest to all Dockerfiles"
```

---

### Task 15: Add Unit Tests

**Files:**

- Create: `apps/status-page/tests/service.unit.test.ts`

**Step 1: Write basic tests**

```ts
import { describe, it, expect } from 'vitest'
import { StatusPageService } from '../src/service.js'
import { TelemetryBuilder } from '@catalyst/telemetry'

describe('StatusPageService', () => {
  it('has correct service info', async () => {
    const config = {
      node: { name: 'test', domains: [] },
      port: 4040,
    }
    const telemetry = TelemetryBuilder.noop('status-page')
    const service = await StatusPageService.create({
      config: config as any,
      telemetry,
    })
    expect(service.info.name).toBe('status-page')
  })
})
```

**Step 2: Run tests**

```bash
pnpm --filter @catalyst/status-page-service test:unit
```

Expected: PASS

**Step 3: Commit**

```bash
gt commit create -m "test: add unit tests for StatusPageService"
```

---

## Summary

| Phase             | Tasks       | What it delivers                                                                  |
| ----------------- | ----------- | --------------------------------------------------------------------------------- |
| 1: Infrastructure | Tasks 1-2   | OTEL exports to Prometheus/Jaeger/InfluxDB, backends running in compose           |
| 2: App Scaffold   | Tasks 3-6   | Working Hono backend with proxy routes, Dockerfile, compose integration           |
| 3: React Frontend | Tasks 7-13  | Full status page UI with health cards, log stream, metrics charts, trace explorer |
| 4: Polish         | Tasks 14-15 | Dockerfile consistency, unit tests                                                |
