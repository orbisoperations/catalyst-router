import { describe, it, expect } from 'vitest'
import { ActionSchema } from '../../src/v2/schema.js'
import {
  UpdateMessageSchema,
  InternalProtocolKeepaliveMessageSchema,
  MAX_UPDATES_PER_MESSAGE,
} from '../../src/v2/internal/actions.js'
import { Actions } from '../../src/v2/action-types.js'

describe('UpdateMessageSchema v2', () => {
  it('rejects update with missing nodePath', () => {
    const result = UpdateMessageSchema.safeParse({
      updates: [{ action: 'add', route: { name: 'svc', protocol: 'http' } }],
    })
    expect(result.success).toBe(false)
  })

  it('rejects update with empty nodePath', () => {
    const result = UpdateMessageSchema.safeParse({
      updates: [
        { action: 'add', route: { name: 'svc', protocol: 'http' }, nodePath: [], originNode: 'a' },
      ],
    })
    expect(result.success).toBe(false)
  })

  it('accepts update with nodePath and originNode', () => {
    const result = UpdateMessageSchema.safeParse({
      updates: [
        {
          action: 'add',
          route: { name: 'svc', protocol: 'http' },
          nodePath: ['node-a'],
          originNode: 'node-a',
        },
      ],
    })
    expect(result.success).toBe(true)
  })

  it('rejects update with missing originNode', () => {
    const result = UpdateMessageSchema.safeParse({
      updates: [{ action: 'add', route: { name: 'svc', protocol: 'http' }, nodePath: ['node-a'] }],
    })
    expect(result.success).toBe(false)
  })

  it(`rejects updates array exceeding ${MAX_UPDATES_PER_MESSAGE} entries`, () => {
    const oversized = Array.from({ length: MAX_UPDATES_PER_MESSAGE + 1 }, (_, i) => ({
      action: 'add' as const,
      route: { name: `svc-${i}`, protocol: 'http' as const },
      nodePath: ['node-a'],
      originNode: 'node-a',
    }))
    const result = UpdateMessageSchema.safeParse({ updates: oversized })
    expect(result.success).toBe(false)
  })

  it(`accepts updates array at exactly ${MAX_UPDATES_PER_MESSAGE} entries`, () => {
    const maxSized = Array.from({ length: MAX_UPDATES_PER_MESSAGE }, (_, i) => ({
      action: 'add' as const,
      route: { name: `svc-${i}`, protocol: 'http' as const },
      nodePath: ['node-a'],
      originNode: 'node-a',
    }))
    const result = UpdateMessageSchema.safeParse({ updates: maxSized })
    expect(result.success).toBe(true)
  })
})

describe('InternalProtocolKeepaliveMessageSchema', () => {
  it('parses valid keepalive', () => {
    const result = InternalProtocolKeepaliveMessageSchema.safeParse({
      action: Actions.InternalProtocolKeepalive,
      data: { peerInfo: { name: 'peer-a', domains: ['example.com'] } },
    })
    expect(result.success).toBe(true)
  })

  it('rejects wrong action type', () => {
    const result = InternalProtocolKeepaliveMessageSchema.safeParse({
      action: 'internal:protocol:update',
      data: { peerInfo: { name: 'peer-a', domains: [] } },
    })
    expect(result.success).toBe(false)
  })
})

describe('InternalProtocolOpen with holdTime', () => {
  it('parses without holdTime (optional)', () => {
    const result = ActionSchema.safeParse({
      action: Actions.InternalProtocolOpen,
      data: { peerInfo: { name: 'peer-a', domains: [] } },
    })
    expect(result.success).toBe(true)
  })

  it('parses with holdTime', () => {
    const result = ActionSchema.safeParse({
      action: Actions.InternalProtocolOpen,
      data: { peerInfo: { name: 'peer-a', domains: [] }, holdTime: 90000 },
    })
    expect(result.success).toBe(true)
  })
})

describe('ActionSchema v2', () => {
  it('parses keepalive through unified schema', () => {
    const result = ActionSchema.safeParse({
      action: Actions.InternalProtocolKeepalive,
      data: { peerInfo: { name: 'peer-a', domains: [] } },
    })
    expect(result.success).toBe(true)
  })

  it('parses all v1 action types', () => {
    // LocalPeerCreate
    expect(
      ActionSchema.safeParse({
        action: Actions.LocalPeerCreate,
        data: { name: 'peer', domains: [] },
      }).success
    ).toBe(true)

    // Tick
    expect(
      ActionSchema.safeParse({
        action: Actions.Tick,
        data: { now: Date.now() },
      }).success
    ).toBe(true)
  })
})
