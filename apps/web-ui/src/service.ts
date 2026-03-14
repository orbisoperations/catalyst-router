import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { CatalystService } from '@catalyst/service'
import type { CatalystServiceOptions } from '@catalyst/service'

export interface WebUiServiceOptions extends CatalystServiceOptions {
  /** Base URL of the orchestrator to proxy dashboard API requests to. */
  readonly orchestratorUrl: string
  /** Absolute path to the directory containing the built frontend assets. */
  readonly frontendDir: string
}

export class WebUiService extends CatalystService {
  readonly info = { name: 'web-ui', version: '0.0.0' }
  readonly handler = new Hono()

  private readonly orchestratorUrl: string
  private readonly frontendDir: string

  constructor(options: WebUiServiceOptions) {
    super(options)
    this.orchestratorUrl = options.orchestratorUrl
    this.frontendDir = options.frontendDir
  }

  protected async onInitialize(): Promise<void> {
    // Proxy /api/* to orchestrator's /dashboard/api/*
    this.handler.get('/api/*', async (c) => {
      const url = new URL(c.req.url)
      const subPath = url.pathname.replace(/^\/api/, '')
      const target = `${this.orchestratorUrl}/dashboard/api${subPath}${url.search}`
      try {
        const res = await fetch(target, {
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
    this.handler.use('/*', serveStatic({ root: this.frontendDir }))
    // SPA fallback — serve index.html for all unmatched routes
    this.handler.get('/*', serveStatic({ root: this.frontendDir, path: 'index.html' }))
  }
}
