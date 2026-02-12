import { CoT } from '@tak-ps/node-tak'
import type { TransformContext, TransformPlugin } from '../types'

/**
 * Raw JSON transform - wraps arbitrary JSON payload into the remarks field.
 */
const plugin: TransformPlugin = {
  name: 'raw-json',
  version: '1.0.0',
  description: 'Wrap arbitrary JSON payload into CoT remarks field',

  validate(payload: unknown): boolean {
    return typeof payload === 'string'
  },

  async transform(payload: unknown, ctx: TransformContext): Promise<CoT | null> {
    const now = new Date()
    const staleMinutes = parseInt(ctx.config.overrides?.staleMinutes || '1', 10)
    const stale = new Date(now.getTime() + staleMinutes * 60000)

    const cotObj = {
      event: {
        _attributes: {
          version: '2.0',
          uid: `zenoh-${ctx.topic.replace(/[^a-zA-Z0-9]/g, '-')}`,
          type: 'b-m-p-s-p-loc',
          how: 'm-g',
          time: now.toISOString(),
          start: now.toISOString(),
          stale: stale.toISOString(),
        },
        point: {
          _attributes: {
            lat: 0.0,
            lon: 0.0,
            hae: 0.0,
            ce: 9999999,
            le: 9999999,
          },
        },
        detail: {
          remarks: {
            _text: JSON.stringify(payload),
          },
          _attributes: {
            source: 'zenoh-tak-adapter',
          },
        },
      },
    }

    return new CoT(cotObj)
  },
}

export default plugin
