import type { DataChannelDefinition } from '@catalyst/routing/v2'

export interface AdapterHealth {
  healthStatus: 'up' | 'down' | 'unknown'
  responseTimeMs: number | null
  lastChecked: string
}

interface AdapterHealthCheckerOptions {
  intervalMs: number
  timeoutMs: number
}

export class AdapterHealthChecker {
  private readonly options: AdapterHealthCheckerOptions
  private readonly healthMap = new Map<string, AdapterHealth>()
  private readonly noHealthEndpoint = new Set<string>()
  private interval: ReturnType<typeof setInterval> | undefined
  private running = false

  constructor(options: AdapterHealthCheckerOptions) {
    this.options = options
  }

  /** Start periodic health checks against the provided route source. */
  start(getRoutes: () => DataChannelDefinition[]): void {
    if (this.options.intervalMs <= 0) return
    this.interval = setInterval(() => {
      if (this.running) return
      this.checkAll(getRoutes()).catch((error) => {
        console.error('[AdapterHealthChecker] Unexpected error during health check cycle:', error)
      })
    }, this.options.intervalMs)
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = undefined
    }
  }

  getHealth(name: string): AdapterHealth | undefined {
    return this.healthMap.get(name)
  }

  /**
   * Apply health data to routes in-place.
   * Used to stamp health fields onto live local routes so they propagate via iBGP,
   * and onto snapshots for API responses.
   */
  applyHealth(routes: DataChannelDefinition[]): DataChannelDefinition[] {
    for (const route of routes) {
      const health = this.healthMap.get(route.name)
      if (health) {
        route.healthStatus = health.healthStatus
        route.responseTimeMs = health.responseTimeMs
        route.lastChecked = health.lastChecked
      }
    }
    return routes
  }

  /** Check all routes and return health results. Clears entries for removed routes. */
  async checkAll(routes: DataChannelDefinition[]): Promise<Map<string, AdapterHealth>> {
    this.running = true
    try {
      const currentNames = new Set(routes.map((r) => r.name))

      // Clear entries for removed routes
      for (const name of this.healthMap.keys()) {
        if (!currentNames.has(name)) {
          this.healthMap.delete(name)
          this.noHealthEndpoint.delete(name)
        }
      }

      const checks = routes.map((route) => this.checkOne(route))
      await Promise.allSettled(checks)

      return this.healthMap
    } finally {
      this.running = false
    }
  }

  private async checkOne(route: DataChannelDefinition): Promise<void> {
    const { name } = route

    // Skip if we already know there's no health endpoint
    if (this.noHealthEndpoint.has(name)) {
      return
    }

    // Skip non-HTTP protocols or missing endpoints
    if (!route.endpoint || !this.isHttpProtocol(route)) {
      this.healthMap.set(name, {
        healthStatus: 'unknown',
        responseTimeMs: null,
        lastChecked: new Date().toISOString(),
      })
      return
    }

    const healthUrl = this.buildHealthUrl(route.endpoint)
    if (!healthUrl) {
      this.healthMap.set(name, {
        healthStatus: 'unknown',
        responseTimeMs: null,
        lastChecked: new Date().toISOString(),
      })
      return
    }

    const start = performance.now()
    try {
      const res = await fetch(healthUrl, {
        signal: AbortSignal.timeout(this.options.timeoutMs),
      })

      if (res.status === 404) {
        const prev = this.healthMap.get(name)
        if (prev?.healthStatus === 'up') {
          // Was healthy before — mark as down, don't suppress future checks
          this.healthMap.set(name, {
            healthStatus: 'down',
            responseTimeMs: null,
            lastChecked: new Date().toISOString(),
          })
        } else {
          // Never been up — no health endpoint, suppress future checks
          this.noHealthEndpoint.add(name)
          this.healthMap.set(name, {
            healthStatus: 'unknown',
            responseTimeMs: null,
            lastChecked: new Date().toISOString(),
          })
        }
        return
      }

      if (res.ok) {
        this.healthMap.set(name, {
          healthStatus: 'up',
          responseTimeMs: Math.round(performance.now() - start),
          lastChecked: new Date().toISOString(),
        })
      } else {
        const prev = this.healthMap.get(name)
        this.healthMap.set(name, {
          healthStatus: prev?.healthStatus === 'up' ? 'down' : 'unknown',
          responseTimeMs: null,
          lastChecked: new Date().toISOString(),
        })
      }
    } catch {
      const prev = this.healthMap.get(name)
      this.healthMap.set(name, {
        healthStatus: prev?.healthStatus === 'up' ? 'down' : 'unknown',
        responseTimeMs: null,
        lastChecked: new Date().toISOString(),
      })
    }
  }

  private isHttpProtocol(route: DataChannelDefinition): boolean {
    return route.protocol.startsWith('http')
  }

  private buildHealthUrl(endpoint: string): string | null {
    try {
      const url = new URL(endpoint)
      url.pathname = '/health'
      return url.toString()
    } catch {
      return null
    }
  }
}
