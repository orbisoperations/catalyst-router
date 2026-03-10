# Dashboard Extraction Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extract the dashboard from the orchestrator into a standalone `apps/web-ui` app so it survives orchestrator restarts.

**Architecture:** A thin Hono server serves the React SPA and proxies `/api/*` requests to the orchestrator's existing `/dashboard/api/*` endpoints over Docker's internal network. The orchestrator keeps its API endpoints but no longer serves static files. Polling stays at 10s (Grafana standard).

**Tech Stack:** Hono, Vite, React, esbuild, Docker

**Design doc:** `docs/plans/2026-03-09-dashboard-extraction-design.md`

---

### Task 1: Create the web-ui app scaffold

**Files:**

- Create: `apps/web-ui/package.json`
- Create: `apps/web-ui/tsconfig.json`
- Create: `apps/web-ui/src/server.ts`

**Step 1: Create `apps/web-ui/package.json`**

```json
{
  "name": "@catalyst/web-ui",
  "version": "0.0.0",
  "type": "module",
  "private": true,
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc",
    "build:frontend": "vite build --config frontend/vite.config.ts",
    "dev:frontend": "vite --config frontend/vite.config.ts",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:unit": "vitest run --exclude '**/*{integration,container}*' --passWithNoTests",
    "test:integration": "vitest run --passWithNoTests container integration"
  },
  "dependencies": {
    "hono": "catalog:",
    "@hono/node-server": "catalog:",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@types/node": "catalog:dev",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.0",
    "typescript": "catalog:dev",
    "vite": "^6.0.0",
    "vitest": "catalog:testing"
  }
}
```

**Step 2: Create `apps/web-ui/tsconfig.json`**

Use the same pattern as other apps — backend only, frontend has its own tsconfig.

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src"],
  "exclude": ["frontend"]
}
```

**Step 3: Create `apps/web-ui/src/server.ts`**

This is the thin backend — serves static files and proxies API calls.

```typescript
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import path from 'node:path'

const app = new Hono()

const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL ?? 'http://localhost:3000'
const PORT = parseInt(process.env.PORT ?? '3000', 10)
const frontendDir = process.env.FRONTEND_DIR ?? path.join(process.cwd(), 'frontend')

// Health endpoint
app.get('/health', (c) => c.json({ status: 'ok' }))

// Proxy /api/* to orchestrator's /dashboard/api/*
app.all('/api/*', async (c) => {
  const subPath = c.req.path.replace(/^\/api/, '')
  const target = `${ORCHESTRATOR_URL}/dashboard/api${subPath}`
  try {
    const res = await fetch(target, {
      method: c.req.method,
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    })
    const body = await res.text()
    return new Response(body, {
      status: res.status,
      headers: { 'Content-Type': res.headers.get('Content-Type') ?? 'application/json' },
    })
  } catch {
    return c.json({ error: 'Orchestrator unreachable' }, 502)
  }
})

// Serve static frontend files
app.use('/*', serveStatic({ root: frontendDir }))
// SPA fallback — serve index.html for all unmatched routes
app.get('/*', serveStatic({ root: frontendDir, path: 'index.html' }))

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`web-ui listening on http://localhost:${info.port}`)
})
```

**Step 4: Run `pnpm install` from the repo root to register the new workspace package**

```bash
pnpm install
```

Expected: lockfile updates, `apps/web-ui` appears in workspace.

**Step 5: Commit**

```
feat(web-ui): scaffold standalone web-ui app with proxy backend
```

---

### Task 2: Move the frontend source from orchestrator to web-ui

**Files:**

- Move: `apps/orchestrator/frontend/` → `apps/web-ui/frontend/`
- Modify: `apps/web-ui/frontend/vite.config.ts` — update base path and proxy target
- Modify: `apps/web-ui/frontend/src/hooks/useHealth.ts` — update fetch URL
- Modify: `apps/web-ui/frontend/src/hooks/useRouterState.ts` — update fetch URL
- Modify: `apps/web-ui/frontend/src/hooks/useConfig.ts` — update fetch URL

**Step 1: Move the frontend directory**

```bash
mv apps/orchestrator/frontend apps/web-ui/frontend
```

**Step 2: Update `apps/web-ui/frontend/vite.config.ts`**

Change from:

```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  root: './frontend',
  base: '/dashboard/',
  build: {
    outDir: '../dist/frontend',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/dashboard/api': {
        target: 'http://localhost:3000',
      },
    },
  },
})
```

Change to:

```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  root: './frontend',
  base: '/',
  build: {
    outDir: '../dist/frontend',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
      },
    },
  },
})
```

Key changes: `base: '/'` (not `/dashboard/`) and proxy target `/api` (not `/dashboard/api`).

**Step 3: Update fetch URLs in frontend hooks**

In `apps/web-ui/frontend/src/hooks/useHealth.ts`, change:

```typescript
const res = await fetch('/dashboard/api/services')
```

to:

```typescript
const res = await fetch('/api/services')
```

In `apps/web-ui/frontend/src/hooks/useRouterState.ts`, change:

```typescript
const res = await fetch('/dashboard/api/state')
```

to:

```typescript
const res = await fetch('/api/state')
```

In `apps/web-ui/frontend/src/hooks/useConfig.ts`, change:

```typescript
fetch('/dashboard/api/config')
```

to:

```typescript
fetch('/api/config')
```

**Step 4: Update `apps/web-ui/frontend/index.html`**

Change the script src from:

```html
<script type="module" src="/src/main.tsx"></script>
```

to:

```html
<script type="module" src="/src/main.tsx"></script>
```

(No change needed — the `/src/main.tsx` path is relative to Vite root, not the base path.)

**Step 5: Commit**

```
feat(web-ui): move frontend from orchestrator and update API paths
```

---

### Task 3: Remove dashboard frontend serving from the orchestrator

**Files:**

- Modify: `apps/orchestrator/src/v1/service.ts:106-126` — remove static file serving and serveStatic import
- Modify: `apps/orchestrator/Dockerfile:44,65` — remove Vite build step and frontend COPY
- Modify: `apps/orchestrator/package.json` — remove react, react-dom, vite, @vitejs/plugin-react dependencies and frontend scripts

**Step 1: In `apps/orchestrator/src/v1/service.ts`**

Remove the `serveStatic` import:

```typescript
import { serveStatic } from '@hono/node-server/serve-static'
```

Remove the `import path from 'node:path'` if it was only used for frontendDir (check first).

Remove these lines (approximately lines 109–126):

```typescript
// Serve dashboard frontend static files (built by Vite)
const frontendDir = process.env.FRONTEND_DIR ?? path.join(process.cwd(), 'frontend')
this.handler.use(
  '/dashboard/*',
  serveStatic({
    root: frontendDir,
    rewriteRequestPath: (p) => p.replace('/dashboard', ''),
  })
)
// SPA fallback — serve index.html for all unmatched dashboard routes
this.handler.get(
  '/dashboard/*',
  serveStatic({
    root: frontendDir,
    path: 'index.html',
    rewriteRequestPath: (p) => p.replace('/dashboard', ''),
  })
)
```

Keep the dashboard API route mount — the orchestrator still serves `/dashboard/api/*`:

```typescript
this.handler.route('/dashboard/api', createDashboardRoutes(this._bus, this.config))
```

**Step 2: In `apps/orchestrator/Dockerfile`**

Remove the Vite build step (line 44):

```dockerfile
RUN cd apps/orchestrator && pnpm exec vite build --config frontend/vite.config.ts
```

Remove the frontend COPY in the runtime stage (line 65):

```dockerfile
COPY --from=build /app/apps/orchestrator/dist/frontend ./frontend
```

Remove the FRONTEND_DIR env var (line 68):

```dockerfile
ENV FRONTEND_DIR=/app/frontend
```

**Step 3: In `apps/orchestrator/package.json`**

Remove these dependencies:

```json
"react": "^19.0.0",
"react-dom": "^19.0.0"
```

Remove these devDependencies:

```json
"@types/react": "^19.0.0",
"@types/react-dom": "^19.0.0",
"@vitejs/plugin-react": "^4.3.0",
"vite": "^6.0.0"
```

Remove these scripts:

```json
"build:frontend": "vite build --config frontend/vite.config.ts",
"dev:frontend": "vite --config frontend/vite.config.ts",
```

**Step 4: Run `pnpm install` to update lockfile**

```bash
pnpm install
```

**Step 5: Commit**

```
refactor(orchestrator): remove dashboard frontend serving
```

---

### Task 4: Create the web-ui Dockerfile

**Files:**

- Create: `apps/web-ui/Dockerfile`

**Step 1: Create `apps/web-ui/Dockerfile`**

Follow the same pattern as the gateway Dockerfile but add the Vite build step.

```dockerfile
# Build from repo root: docker build -f apps/web-ui/Dockerfile -t catalyst-web-ui .
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
COPY apps/web-ui/package.json apps/web-ui/
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

# Copy web-ui source
COPY apps/web-ui apps/web-ui

# Build frontend with Vite
RUN cd apps/web-ui && pnpm exec vite build --config frontend/vite.config.ts

# Bundle backend with esbuild
RUN pnpm exec esbuild apps/web-ui/src/server.ts \
  --bundle --platform=node --target=node22 \
  --outfile=dist/server.mjs --format=esm \
  --banner:js='import{createRequire}from"module";import{fileURLToPath as __file}from"url";import{dirname as __dir}from"path";const require=createRequire(import.meta.url),__filename=__file(import.meta.url),__dirname=__dir(__filename);'

# Create production deployment with flat node_modules
RUN pnpm deploy --filter=@catalyst/web-ui --prod /deploy

# Runtime stage
FROM node:22-alpine
WORKDIR /app

COPY --from=build /deploy/node_modules ./node_modules
COPY --from=build /app/dist/server.mjs ./server.mjs
COPY --from=build /app/apps/web-ui/dist/frontend ./frontend

ENV PORT=3000
ENV FRONTEND_DIR=/app/frontend
EXPOSE 3000

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

CMD ["node", "server.mjs"]
```

**Step 2: Commit**

```
feat(web-ui): add Dockerfile with Vite build and esbuild bundle
```

---

### Task 5: Update docker-compose to add web-ui service

**Files:**

- Modify: `docker-compose/docker.compose.yaml` — add web-ui service
- Modify: `docker-compose/two-node.compose.yaml` — add web-ui service (if it exists)

**Step 1: Add web-ui service to `docker-compose/docker.compose.yaml`**

Add this service block after the `orchestrator` service:

```yaml
web-ui:
  build:
    context: ..
    dockerfile: apps/web-ui/Dockerfile
  ports:
    - '8080:3000'
  environment:
    - ORCHESTRATOR_URL=http://orchestrator:3000
  healthcheck:
    test: ['CMD', 'wget', '--no-verbose', '--tries=1', '--spider', 'http://127.0.0.1:3000/health']
    interval: 10s
    timeout: 5s
    retries: 5
  depends_on:
    orchestrator:
      condition: service_healthy
```

**Step 2: Update `docker-compose/two-node.compose.yaml`**

Check if this file has its own orchestrator config. If so, add a web-ui service that points to the appropriate orchestrator. Use `ORCHESTRATOR_URL=http://orchestrator-a:3000` (or whichever is the primary node).

**Step 3: Also update the orchestrator Dockerfile's `COPY` lines**

Since we added `apps/web-ui/package.json` to the workspace, any Dockerfile that copies all `package.json` files for `pnpm install --frozen-lockfile` needs the new entry. Add to the orchestrator, gateway, envoy, and auth Dockerfiles:

```dockerfile
COPY apps/web-ui/package.json apps/web-ui/
```

This is required because `pnpm install --frozen-lockfile` validates the lockfile against all workspace packages.

**Step 4: Commit**

```
feat(docker): add web-ui service to docker-compose configs
```

---

### Task 6: Docker build and smoke test

**Files:** No new files — this is a verification task.

**Step 1: Build the full stack**

```bash
cd docker-compose
docker compose build
```

Expected: All services build successfully, including `web-ui`.

**Step 2: Start the stack**

```bash
docker compose up -d
```

Wait for all services to be healthy:

```bash
docker compose ps
```

**Step 3: Smoke test the web-ui**

```bash
# Health endpoint
curl -s http://localhost:8080/health
# Expected: {"status":"ok"}

# API proxy — state
curl -s http://localhost:8080/api/state | head -c 200
# Expected: JSON with routes and peers

# API proxy — services
curl -s http://localhost:8080/api/services | head -c 200
# Expected: JSON with groups array

# API proxy — config
curl -s http://localhost:8080/api/config
# Expected: JSON with links object

# Orchestrator no longer serves frontend
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/dashboard/
# Expected: 404 (no static files served)

# Orchestrator still serves API
curl -s http://localhost:3000/dashboard/api/state | head -c 200
# Expected: JSON with routes and peers
```

**Step 4: Playwright screenshot**

Open `http://localhost:8080` in a browser (via Playwright) and take a screenshot to verify the dashboard renders with real data.

**Step 5: Orchestrator restart resilience test**

```bash
docker compose restart orchestrator
```

While the orchestrator is restarting:

```bash
# Web-UI should still be running
curl -s http://localhost:8080/health
# Expected: {"status":"ok"}

# API should return 502 (orchestrator unreachable)
curl -s http://localhost:8080/api/state
# Expected: {"error":"Orchestrator unreachable"}
```

After orchestrator is healthy again:

```bash
curl -s http://localhost:8080/api/state | head -c 200
# Expected: JSON with routes and peers (proxy works again)
```

**Step 6: Commit (if any fixes were needed)**

```
fix(web-ui): [description of any fixes discovered during testing]
```
