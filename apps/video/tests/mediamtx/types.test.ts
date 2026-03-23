import { describe, expect, it } from 'vitest'
import { MediaMtxAuthRequestSchema, MediaMtxHookPayloadSchema } from '../../src/mediamtx/types.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const validAuthRequest = {
  user: '',
  password: '',
  token: 'eyJhbGciOiJSUzI1NiIs.test',
  ip: '192.168.1.100',
  action: 'read' as const,
  path: 'cam-front',
  protocol: 'rtsp' as const,
  id: 'conn-001',
  query: '',
}

const validHookPayload = {
  path: 'cam-front',
  sourceType: 'rtspSession',
  sourceId: 'abc123',
}

// ---------------------------------------------------------------------------
// MediaMtxAuthRequestSchema
// ---------------------------------------------------------------------------

describe('MediaMtxAuthRequestSchema', () => {
  describe('happy path', () => {
    it('parses valid publish auth request', () => {
      const result = MediaMtxAuthRequestSchema.parse({
        ...validAuthRequest,
        action: 'publish',
        ip: '127.0.0.1',
      })
      expect(result.action).toBe('publish')
      expect(result.ip).toBe('127.0.0.1')
    })

    it('parses valid read auth request', () => {
      const result = MediaMtxAuthRequestSchema.parse(validAuthRequest)
      expect(result.action).toBe('read')
      expect(result.token).toBe('eyJhbGciOiJSUzI1NiIs.test')
    })

    it('parses valid playback auth request', () => {
      const result = MediaMtxAuthRequestSchema.parse({
        ...validAuthRequest,
        action: 'playback',
      })
      expect(result.action).toBe('playback')
    })

    it('accepts all supported protocol values', () => {
      for (const protocol of ['rtsp', 'rtmp', 'hls'] as const) {
        const result = MediaMtxAuthRequestSchema.parse({
          ...validAuthRequest,
          protocol,
        })
        expect(result.protocol).toBe(protocol)
      }
    })

    it('accepts optional user and password as empty strings', () => {
      const result = MediaMtxAuthRequestSchema.parse({
        ...validAuthRequest,
        user: '',
        password: '',
      })
      expect(result.user).toBe('')
      expect(result.password).toBe('')
    })

    it('accepts optional token as empty string', () => {
      const result = MediaMtxAuthRequestSchema.parse({
        ...validAuthRequest,
        token: '',
      })
      expect(result.token).toBe('')
    })

    it('accepts request without optional fields', () => {
      const result = MediaMtxAuthRequestSchema.parse({
        ip: '10.0.1.5',
        action: 'read',
        path: 'cam-front',
        protocol: 'rtsp',
        id: 'conn-1',
      })
      expect(result.user).toBeUndefined()
      expect(result.password).toBeUndefined()
      expect(result.token).toBeUndefined()
      expect(result.query).toBeUndefined()
    })
  })

  describe('validation errors', () => {
    it('rejects missing action field', () => {
      const { action: _action, ...rest } = validAuthRequest
      const result = MediaMtxAuthRequestSchema.safeParse(rest)
      expect(result.success).toBe(false)
    })

    it('rejects invalid action value', () => {
      const result = MediaMtxAuthRequestSchema.safeParse({
        ...validAuthRequest,
        action: 'delete',
      })
      expect(result.success).toBe(false)
    })

    it('rejects missing ip field', () => {
      const { ip: _ip, ...rest } = validAuthRequest
      const result = MediaMtxAuthRequestSchema.safeParse(rest)
      expect(result.success).toBe(false)
    })

    it('rejects missing path field', () => {
      const { path: _path, ...rest } = validAuthRequest
      const result = MediaMtxAuthRequestSchema.safeParse(rest)
      expect(result.success).toBe(false)
    })

    it('rejects missing protocol field', () => {
      const { protocol: _protocol, ...rest } = validAuthRequest
      const result = MediaMtxAuthRequestSchema.safeParse(rest)
      expect(result.success).toBe(false)
    })

    it('rejects missing id field', () => {
      const { id: _id, ...rest } = validAuthRequest
      const result = MediaMtxAuthRequestSchema.safeParse(rest)
      expect(result.success).toBe(false)
    })

    it('rejects invalid protocol value', () => {
      const result = MediaMtxAuthRequestSchema.safeParse({
        ...validAuthRequest,
        protocol: 'websocket',
      })
      expect(result.success).toBe(false)
    })
  })
})

// ---------------------------------------------------------------------------
// MediaMtxHookPayloadSchema
// ---------------------------------------------------------------------------

describe('MediaMtxHookPayloadSchema', () => {
  describe('happy path', () => {
    it('parses valid hook payload', () => {
      const result = MediaMtxHookPayloadSchema.parse(validHookPayload)
      expect(result.path).toBe('cam-front')
      expect(result.sourceType).toBe('rtspSession')
      expect(result.sourceId).toBe('abc123')
    })

    it('accepts path with dots and hyphens', () => {
      const result = MediaMtxHookPayloadSchema.parse({
        ...validHookPayload,
        path: 'cam.front-1',
      })
      expect(result.path).toBe('cam.front-1')
    })

    it('accepts path with underscores', () => {
      const result = MediaMtxHookPayloadSchema.parse({
        ...validHookPayload,
        path: 'cam_01_front',
      })
      expect(result.path).toBe('cam_01_front')
    })

    it('accepts path matching full character set', () => {
      const result = MediaMtxHookPayloadSchema.parse({
        ...validHookPayload,
        path: 'Cam_01.front-view',
      })
      expect(result.path).toBe('Cam_01.front-view')
    })

    it('accepts single character path', () => {
      const result = MediaMtxHookPayloadSchema.parse({
        ...validHookPayload,
        path: 'a',
      })
      expect(result.path).toBe('a')
    })
  })

  describe('validation errors', () => {
    it('rejects path with shell metacharacters (semicolon)', () => {
      const result = MediaMtxHookPayloadSchema.safeParse({
        ...validHookPayload,
        path: 'cam;rm -rf /',
      })
      expect(result.success).toBe(false)
    })

    it('rejects path with slashes', () => {
      const result = MediaMtxHookPayloadSchema.safeParse({
        ...validHookPayload,
        path: '../etc/passwd',
      })
      expect(result.success).toBe(false)
    })

    it('rejects path with spaces', () => {
      const result = MediaMtxHookPayloadSchema.safeParse({
        ...validHookPayload,
        path: 'cam front',
      })
      expect(result.success).toBe(false)
    })

    it('rejects empty path', () => {
      const result = MediaMtxHookPayloadSchema.safeParse({
        ...validHookPayload,
        path: '',
      })
      expect(result.success).toBe(false)
    })

    it('rejects missing path field', () => {
      const { path: _path, ...rest } = validHookPayload
      const result = MediaMtxHookPayloadSchema.safeParse(rest)
      expect(result.success).toBe(false)
    })

    it('rejects missing sourceType field', () => {
      const { sourceType: _sourceType, ...rest } = validHookPayload
      const result = MediaMtxHookPayloadSchema.safeParse(rest)
      expect(result.success).toBe(false)
    })

    it('rejects missing sourceId field', () => {
      const { sourceId: _sourceId, ...rest } = validHookPayload
      const result = MediaMtxHookPayloadSchema.safeParse(rest)
      expect(result.success).toBe(false)
    })

    it('rejects path with backticks', () => {
      const result = MediaMtxHookPayloadSchema.safeParse({
        ...validHookPayload,
        path: '`whoami`',
      })
      expect(result.success).toBe(false)
    })

    it('rejects path with dollar sign', () => {
      const result = MediaMtxHookPayloadSchema.safeParse({
        ...validHookPayload,
        path: '$HOME',
      })
      expect(result.success).toBe(false)
    })

    it('rejects path with pipe character', () => {
      const result = MediaMtxHookPayloadSchema.safeParse({
        ...validHookPayload,
        path: 'cam|cat /etc/passwd',
      })
      expect(result.success).toBe(false)
    })

    it('rejects path with ampersand', () => {
      const result = MediaMtxHookPayloadSchema.safeParse({
        ...validHookPayload,
        path: 'cam&bg',
      })
      expect(result.success).toBe(false)
    })

    it('rejects path with parentheses', () => {
      const result = MediaMtxHookPayloadSchema.safeParse({
        ...validHookPayload,
        path: 'cam$(cmd)',
      })
      expect(result.success).toBe(false)
    })

    it('rejects path with newline', () => {
      const result = MediaMtxHookPayloadSchema.safeParse({
        ...validHookPayload,
        path: 'cam\nfront',
      })
      expect(result.success).toBe(false)
    })
  })
})
