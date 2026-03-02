import { Hono } from 'hono'
import { z } from 'zod'
import type { StreamState } from '../state/stream-state.js'

export function createStreamsRouter(streamState: StreamState): Hono {
  const app = new Hono()
  const SourceQuerySchema = z.enum(['local', 'remote', 'all'])

  app.get('/streams', (c) => {
    // TODO (Phase 4): Bearer JWT validation + auth service ROUTE_LIST check
    const rawSource = c.req.query('source')
    const sourceResult = SourceQuerySchema.safeParse(rawSource ?? 'all')
    if (!sourceResult.success) {
      return c.json({ error: `Invalid source filter: "${rawSource}"` }, 400)
    }
    const source = sourceResult.data
    const tag = c.req.query('tag')

    let streams =
      source === 'local'
        ? streamState.listLocal()
        : source === 'remote'
          ? streamState.listRemote()
          : streamState.listAll()

    if (tag) {
      streams = streams.filter((s) => s.tags.includes(tag))
    }

    return c.json({ streams })
  })

  return app
}
