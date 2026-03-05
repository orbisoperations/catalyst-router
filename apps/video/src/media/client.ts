import { z } from 'zod'

export const PathConfigSchema = z.object({
  source: z.string().optional(),
  sourceOnDemand: z.boolean().optional(),
  sourceOnDemandCloseAfter: z.string().optional(),
})

export type PathConfig = z.infer<typeof PathConfigSchema>

export const PathInfoSchema = z.object({
  name: z.string(),
  source: z.string().optional(),
  ready: z.boolean(),
})

export type PathInfo = z.infer<typeof PathInfoSchema>

const ListPathsResponseSchema = z.object({
  items: z.array(PathInfoSchema).optional(),
})

export type Result = { success: true } | { success: false; error: string }

export interface MediaServerClient {
  addPath(name: string, config: PathConfig): Promise<Result>
  removePath(name: string): Promise<Result>
  listPaths(): Promise<PathInfo[]>
}

export class HttpMediaServerClient implements MediaServerClient {
  constructor(private baseUrl: string) {}

  async addPath(name: string, config: PathConfig): Promise<Result> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    try {
      const res = await fetch(`${this.baseUrl}/v3/config/paths/add/${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
        signal: controller.signal,
      })
      if (!res.ok) {
        return { success: false, error: `MediaMTX addPath failed: ${res.status} ${res.statusText}` }
      }
      return { success: true }
    } catch (e) {
      return { success: false, error: `MediaMTX addPath error: ${e}` }
    } finally {
      clearTimeout(timeout)
    }
  }

  async removePath(name: string): Promise<Result> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    try {
      const res = await fetch(
        `${this.baseUrl}/v3/config/paths/remove/${encodeURIComponent(name)}`,
        { method: 'POST', signal: controller.signal }
      )
      if (!res.ok) {
        return {
          success: false,
          error: `MediaMTX removePath failed: ${res.status} ${res.statusText}`,
        }
      }
      return { success: true }
    } catch (e) {
      return { success: false, error: `MediaMTX removePath error: ${e}` }
    } finally {
      clearTimeout(timeout)
    }
  }

  async listPaths(): Promise<PathInfo[]> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    try {
      const res = await fetch(`${this.baseUrl}/v3/paths/list`, { signal: controller.signal })
      if (!res.ok) return []
      const parsed = ListPathsResponseSchema.safeParse(await res.json())
      if (!parsed.success) return []
      return parsed.data.items ?? []
    } catch {
      return []
    } finally {
      clearTimeout(timeout)
    }
  }
}

export class MockMediaServerClient implements MediaServerClient {
  readonly paths = new Map<string, PathConfig>()

  async addPath(name: string, config: PathConfig): Promise<Result> {
    this.paths.set(name, config)
    return { success: true }
  }

  async removePath(name: string): Promise<Result> {
    this.paths.delete(name)
    return { success: true }
  }

  async listPaths(): Promise<PathInfo[]> {
    return [...this.paths.entries()].map(([name, config]) => ({
      name,
      source: config.source,
      ready: true,
    }))
  }
}
