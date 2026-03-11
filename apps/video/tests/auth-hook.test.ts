import { describe, it, expect } from 'vitest'
import { createAuthRouter } from '../src/hooks/auth.js'

describe('Auth Hook Router', () => {
  describe('publish (action: publish)', () => {
    it('allows publish from localhost 127.0.0.1', async () => {
      const router = createAuthRouter({ authFailPublish: 'closed', authFailSubscribe: 'closed' })
      const res = await router.request('/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ip: '127.0.0.1',
          action: 'publish',
          path: 'cam-front',
          protocol: 'rtsp',
          user: '',
          password: '',
          id: 'abc',
          query: '',
        }),
      })
      expect(res.status).toBe(200)
    })

    it('allows publish from localhost ::1', async () => {
      const router = createAuthRouter({ authFailPublish: 'closed', authFailSubscribe: 'closed' })
      const res = await router.request('/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ip: '::1',
          action: 'publish',
          path: 'cam-front',
          protocol: 'rtsp',
          user: '',
          password: '',
          id: 'abc',
          query: '',
        }),
      })
      expect(res.status).toBe(200)
    })

    it('rejects publish from remote IP', async () => {
      const router = createAuthRouter({ authFailPublish: 'closed', authFailSubscribe: 'closed' })
      const res = await router.request('/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ip: '192.168.1.100',
          action: 'publish',
          path: 'cam-front',
          protocol: 'rtsp',
          user: '',
          password: '',
          id: 'abc',
          query: '',
        }),
      })
      expect(res.status).toBe(401)
    })
  })

  describe('read (action: read)', () => {
    it('denies read when authFailSubscribe is closed', async () => {
      const router = createAuthRouter({ authFailPublish: 'closed', authFailSubscribe: 'closed' })
      const res = await router.request('/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ip: '10.0.0.5',
          action: 'read',
          path: 'node-a/cam-front',
          protocol: 'rtsp',
          user: '',
          password: '',
          id: 'abc',
          query: '',
        }),
      })
      expect(res.status).toBe(401)
    })

    it('allows read when authFailSubscribe is open', async () => {
      const router = createAuthRouter({ authFailPublish: 'closed', authFailSubscribe: 'open' })
      const res = await router.request('/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ip: '10.0.0.5',
          action: 'read',
          path: 'node-a/cam-front',
          protocol: 'rtsp',
          user: '',
          password: '',
          id: 'abc',
          query: '',
        }),
      })
      expect(res.status).toBe(200)
    })
  })

  describe('fail-closed behavior', () => {
    it('denies publish from remote even with authFailPublish open', async () => {
      const router = createAuthRouter({ authFailPublish: 'open', authFailSubscribe: 'open' })
      const res = await router.request('/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ip: '192.168.1.100',
          action: 'publish',
          path: 'cam-front',
          protocol: 'rtsp',
          user: '',
          password: '',
          id: 'abc',
          query: '',
        }),
      })
      // Remote publish is always rejected regardless of fail mode
      expect(res.status).toBe(401)
    })
  })
})
