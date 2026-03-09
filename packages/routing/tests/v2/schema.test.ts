import { describe, it, expect } from 'vitest'
import { ActionSchema } from '../../src/v2/schema.js'
import {
  UpdateMessageSchema,
  InternalProtocolKeepaliveMessageSchema,
  MAX_UPDATES_PER_MESSAGE,
  MAX_NODE_PATH_HOPS,
  MAX_NODE_ID_LENGTH,
} from '../../src/v2/internal/actions.js'
import { DataChannelDefinitionSchema, MAX_TAGS_PER_CHANNEL } from '../../src/v2/datachannel.js'
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

  it(`rejects nodePath exceeding ${MAX_NODE_PATH_HOPS} hops`, () => {
    const longPath = Array.from({ length: MAX_NODE_PATH_HOPS + 1 }, (_, i) => `node-${i}`)
    const result = UpdateMessageSchema.safeParse({
      updates: [
        {
          action: 'add',
          route: { name: 'svc', protocol: 'http' },
          nodePath: longPath,
          originNode: 'node-0',
        },
      ],
    })
    expect(result.success).toBe(false)
  })

  it(`accepts nodePath at exactly ${MAX_NODE_PATH_HOPS} hops`, () => {
    const maxPath = Array.from({ length: MAX_NODE_PATH_HOPS }, (_, i) => `node-${i}`)
    const result = UpdateMessageSchema.safeParse({
      updates: [
        {
          action: 'add',
          route: { name: 'svc', protocol: 'http' },
          nodePath: maxPath,
          originNode: 'node-0',
        },
      ],
    })
    expect(result.success).toBe(true)
  })

  it(`rejects originNode longer than ${MAX_NODE_ID_LENGTH} characters`, () => {
    const longId = 'a'.repeat(MAX_NODE_ID_LENGTH + 1)
    const result = UpdateMessageSchema.safeParse({
      updates: [
        {
          action: 'add',
          route: { name: 'svc', protocol: 'http' },
          nodePath: ['node-a'],
          originNode: longId,
        },
      ],
    })
    expect(result.success).toBe(false)
  })

  it(`rejects individual nodePath hop longer than ${MAX_NODE_ID_LENGTH} characters`, () => {
    const longHop = 'a'.repeat(MAX_NODE_ID_LENGTH + 1)
    const result = UpdateMessageSchema.safeParse({
      updates: [
        {
          action: 'add',
          route: { name: 'svc', protocol: 'http' },
          nodePath: [longHop],
          originNode: 'node-a',
        },
      ],
    })
    expect(result.success).toBe(false)
  })
})

describe('DataChannelDefinitionSchema field bounds', () => {
  it(`rejects tags array exceeding ${MAX_TAGS_PER_CHANNEL} entries`, () => {
    const oversizedTags = Array.from({ length: MAX_TAGS_PER_CHANNEL + 1 }, (_, i) => `tag-${i}`)
    const result = DataChannelDefinitionSchema.safeParse({
      name: 'svc',
      protocol: 'http',
      tags: oversizedTags,
    })
    expect(result.success).toBe(false)
  })

  it(`accepts tags array at exactly ${MAX_TAGS_PER_CHANNEL} entries`, () => {
    const maxTags = Array.from({ length: MAX_TAGS_PER_CHANNEL }, (_, i) => `tag-${i}`)
    const result = DataChannelDefinitionSchema.safeParse({
      name: 'svc',
      protocol: 'http',
      tags: maxTags,
    })
    expect(result.success).toBe(true)
  })

  it('accepts channel with no tags (optional)', () => {
    const result = DataChannelDefinitionSchema.safeParse({ name: 'svc', protocol: 'http' })
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
