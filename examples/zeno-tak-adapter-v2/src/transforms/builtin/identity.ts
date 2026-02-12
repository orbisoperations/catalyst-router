import { CoTParser } from '@tak-ps/node-cot'
import { CoT } from '@tak-ps/node-tak'
import type { TransformContext, TransformPlugin } from '../types'

/**
 * Identity transform - passes through CoT payloads as-is.
 */
const plugin: TransformPlugin = {
  name: 'identity',
  version: '1.0.0',
  description: 'Pass-through transform for valid CoT payloads',

  validate(payload: unknown): boolean {
    return typeof payload === 'string' || (typeof payload === 'object' && payload !== null)
  },

  async transform(payload: unknown, ctx: TransformContext): Promise<CoT | null> {
    try {
      if (typeof payload === 'string') {
        return CoTParser.from_xml(payload)
      }
      if (typeof payload === 'object' && payload !== null) {
        return new CoT(payload)
      }
      ctx.logger.warn('Invalid payload: expected string or object')
      return null
    } catch (e) {
      ctx.logger.error('Failed to parse CoT payload', e)
      return null
    }
  },
}

export default plugin
