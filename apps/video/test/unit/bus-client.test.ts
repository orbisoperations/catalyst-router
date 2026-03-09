import { describe, expect, it, vi } from 'vitest'

import { type DispatchCapability, type VideoAction, VideoBusClient } from '../../src/bus-client.js'

const sampleAction: VideoAction = {
  action: 'subscribe',
  data: {
    name: 'cam-front',
    protocol: 'rtsp',
    endpoint: 'rtsp://192.168.1.10:8554/cam-front',
  },
}

describe('VideoBusClient', () => {
  it('returns an empty catalog by default', () => {
    const client = new VideoBusClient()
    expect(client.catalog).toEqual({ streams: [] })
  })

  it('setCatalog updates the catalog and getter reflects the new value', () => {
    const client = new VideoBusClient()
    const catalog = {
      streams: [
        {
          name: 'cam-1',
          protocol: 'rtsp',
          source: 'local' as const,
          sourceNode: 'node-a',
        },
      ],
    }

    client.setCatalog(catalog)

    expect(client.catalog).toBe(catalog)
    expect(client.catalog.streams).toHaveLength(1)
    expect(client.catalog.streams[0].name).toBe('cam-1')
  })

  it('dispatch succeeds when capability is set', async () => {
    const client = new VideoBusClient()
    const mockCapability: DispatchCapability = {
      dispatch: vi.fn().mockResolvedValue({ success: true }),
    }

    client.setDispatch(mockCapability)
    const result = await client.dispatch(sampleAction)

    expect(result).toEqual({ success: true })
    expect(mockCapability.dispatch).toHaveBeenCalledWith(sampleAction)
  })

  it('dispatch throws when no capability is set', async () => {
    const client = new VideoBusClient()

    await expect(client.dispatch(sampleAction)).rejects.toThrow(
      'Cannot dispatch: no orchestrator connection (dispatch capability not set)'
    )
  })

  it('dispatch returns failure when orchestrator returns success: false', async () => {
    const client = new VideoBusClient()
    const mockCapability: DispatchCapability = {
      dispatch: vi.fn().mockResolvedValue({ success: false }),
    }

    client.setDispatch(mockCapability)
    const result = await client.dispatch(sampleAction)

    expect(result).toEqual({ success: false })
  })

  it('clearDispatch removes the capability; subsequent dispatch throws', async () => {
    const client = new VideoBusClient()
    const mockCapability: DispatchCapability = {
      dispatch: vi.fn().mockResolvedValue({ success: true }),
    }

    client.setDispatch(mockCapability)
    expect(client.hasDispatch).toBe(true)

    client.clearDispatch()

    await expect(client.dispatch(sampleAction)).rejects.toThrow(
      'Cannot dispatch: no orchestrator connection (dispatch capability not set)'
    )
  })

  it('hasDispatch returns true when set, false when cleared', () => {
    const client = new VideoBusClient()
    expect(client.hasDispatch).toBe(false)

    const mockCapability: DispatchCapability = {
      dispatch: vi.fn().mockResolvedValue({ success: true }),
    }

    client.setDispatch(mockCapability)
    expect(client.hasDispatch).toBe(true)

    client.clearDispatch()
    expect(client.hasDispatch).toBe(false)
  })
})
