import { CoT } from '@tak-ps/node-tak'
import type { TransformContext, TransformPlugin } from '../types'

interface SimpleCotPayload {
  lat?: number
  lon?: number
  hae?: number
  type?: string
  uid?: string
  callsign?: string
  remarks?: string
}

/**
 * Simple CoT transform - maps JSON fields to CoT attributes.
 */
const plugin: TransformPlugin = {
  name: 'simple-cot',
  version: '1.0.0',
  description: 'Map simple JSON payload to CoT event',

  validate(payload: unknown): boolean {
    return typeof payload === 'object' && payload !== null
  },

  async transform(payload: SimpleCotPayload | null, ctx: TransformContext) {
    if (typeof payload !== 'object' || payload === null) {
      ctx.logger.warn('Invalid payload: expected object')
      return null
    }

    const now = new Date()

    const staleMinutes = parseInt(ctx.config.overrides?.staleMinutes || '1', 10)
    const stale = new Date(now.getTime() + staleMinutes * 60000)

    const uid = payload.uid || `zenoh-${ctx.topic.replace(/[^a-zA-Z0-9]/g, '-')}`
    const type = payload.type || 'a-u-G'
    const callsign = payload.callsign || ctx.topic

    const lat = payload.lat || 0.0
    const lon = payload.lon || 0.0
    const hae = payload.hae || 0.0

    const cotObj = {
      event: {
        _attributes: {
          version: '2.0',
          uid,
          type,
          how: 'm-g',
          time: now.toISOString(),
          start: now.toISOString(),
          stale: stale.toISOString(),
        },
        point: {
          _attributes: {
            lat: Number(lat),
            lon: Number(lon),
            hae: Number(hae),
            ce: 10,
            le: 10,
          },
        },
        detail: {
          contact: {
            _attributes: {
              callsign,
            },
          },
          remarks: {
            _text: payload.remarks || '',
          },
        },
      },
    }

    return new CoT(cotObj)
  },
}

export default plugin
