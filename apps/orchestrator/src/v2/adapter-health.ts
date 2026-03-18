import { Actions, type DataChannelDefinition } from '@catalyst/routing/v2'

export interface AdapterHealth {
  healthStatus: 'up' | 'down'
  responseTimeMs: number | null
  lastChecked: string
}

interface AdapterHealthCheckerOptions {
  intervalMs: number
  timeoutMs: number
  dispatchFn?: (action: { action: string; data: Record<string, unknown> }) => Promise<unknown>
}

export class AdapterHealthChecker {
  private readonly options: AdapterHealthCheckerOptions
  private readonly healthMap = new Map<string, AdapterHealth>()
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
   * Apply latest health data to routes in-place. Used on snapshot clones for
   * API responses — does NOT affect the RIB or trigger iBGP propagation.
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
    const prevStatus = this.healthMap.get(name)?.healthStatus

    // Non-HTTP protocols or missing endpoints → down
    if (!route.endpoint || !this.isHttpProtocol(route)) {
      this.setHealth(name, 'down', null)
      this.maybeDispatch(name, prevStatus)
      return
    }

    const healthUrl = this.buildHealthUrl(route.endpoint)
    if (!healthUrl) {
      this.setHealth(name, 'down', null)
      this.maybeDispatch(name, prevStatus)
      return
    }

    const start = performance.now()
    try {
      const res = await fetch(healthUrl, {
        signal: AbortSignal.timeout(this.options.timeoutMs),
      })

      if (res.ok) {
        this.setHealth(name, 'up', Math.round(performance.now() - start))
      } else {
        this.setHealth(name, 'down', null)
      }
    } catch {
      this.setHealth(name, 'down', null)
    }

    this.maybeDispatch(name, prevStatus)
  }

  private setHealth(
    name: string,
    healthStatus: 'up' | 'down',
    responseTimeMs: number | null
  ): void {
    this.healthMap.set(name, {
      healthStatus,
      responseTimeMs,
      lastChecked: new Date().toISOString(),
    })
  }

  /** Dispatch to bus if health status changed (for iBGP propagation). */
  private maybeDispatch(name: string, prevStatus: string | undefined): void {
    const newHealth = this.healthMap.get(name)
    if (!this.options.dispatchFn || !newHealth || prevStatus === newHealth.healthStatus) return

    this.options
      .dispatchFn({
        action: Actions.LocalRouteHealthUpdate,
        data: {
          name,
          healthStatus: newHealth.healthStatus,
          responseTimeMs: newHealth.responseTimeMs,
          lastChecked: newHealth.lastChecked,
        },
      })
      .catch((error) => {
        console.error(`[AdapterHealthChecker] Failed to dispatch health update for ${name}:`, error)
      })
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
