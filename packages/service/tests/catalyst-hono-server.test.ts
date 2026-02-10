import { describe, it, expect, afterEach } from 'vitest'
import { Hono } from 'hono'
import { CatalystHonoServer, catalystHonoServer } from '../src/catalyst-hono-server.js'

// Use high ephemeral ports to avoid conflicts with running services
let nextPort = 19_100
function getPort(): number {
  return nextPort++
}

describe('CatalystHonoServer', () => {
  const servers: CatalystHonoServer[] = []

  function tracked(server: CatalystHonoServer): CatalystHonoServer {
    servers.push(server)
    return server
  }

  afterEach(async () => {
    for (const s of servers) {
      await s.stop()
    }
    servers.length = 0
  })

  it('starts and responds to /health', async () => {
    const port = getPort()
    const handler = new Hono()
    const server = tracked(new CatalystHonoServer(handler, { port }))
    server.start()

    const res = await fetch(`http://localhost:${port}/health`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('ok')
  })

  it('mounts the provided handler', async () => {
    const port = getPort()
    const handler = new Hono()
    handler.get('/ping', (c) => c.text('pong'))

    const server = tracked(new CatalystHonoServer(handler, { port }))
    server.start()

    const res = await fetch(`http://localhost:${port}/ping`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('pong')
  })

  it('includes service names in /health response', async () => {
    const port = getPort()
    const handler = new Hono()
    const mockService = { info: { name: 'test-svc', version: '1.0.0' }, shutdown: async () => {} }

    const server = tracked(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new CatalystHonoServer(handler, { port, services: [mockService as any] })
    )
    server.start()

    const res = await fetch(`http://localhost:${port}/health`)
    const body = await res.json()
    expect(body.services).toEqual(['test-svc'])
  })

  it('throws if start() is called while already running', () => {
    const port = getPort()
    const handler = new Hono()
    const server = tracked(new CatalystHonoServer(handler, { port }))
    server.start()

    expect(() => server.start()).toThrow(/already running/)
  })

  it('throws if the requested port is already in use', async () => {
    const port = getPort()

    // Occupy the port with a raw Bun server
    const blocker = Bun.serve({ fetch: () => new Response('busy'), port })

    try {
      const handler = new Hono()
      const server = new CatalystHonoServer(handler, { port })

      expect(() => server.start()).toThrow(/port.*in use|already in use/i)
    } finally {
      blocker.stop()
    }
  })

  it('can be stopped and restarted', async () => {
    const port = getPort()
    const handler = new Hono()
    const server = tracked(new CatalystHonoServer(handler, { port }))

    server.start()
    const res1 = await fetch(`http://localhost:${port}/health`)
    expect(res1.status).toBe(200)

    await server.stop()

    // Should be able to start again after stop
    server.start()
    const res2 = await fetch(`http://localhost:${port}/health`)
    expect(res2.status).toBe(200)
  })

  it('stop is idempotent', async () => {
    const port = getPort()
    const handler = new Hono()
    const server = tracked(new CatalystHonoServer(handler, { port }))
    server.start()

    await server.stop()
    // Second stop should not throw
    await server.stop()
  })

  describe('catalystHonoServer()', () => {
    it('returns a CatalystHonoServer instance', () => {
      const server = catalystHonoServer(new Hono())
      expect(server).toBeInstanceOf(CatalystHonoServer)
    })
  })
})
