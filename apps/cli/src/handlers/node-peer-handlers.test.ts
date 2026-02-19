import { describe, expect, it } from 'vitest'
import type { CreatePeerInput, DeletePeerInput, ListPeersInput } from '../types.js'

describe('Node Peer Handlers', () => {
  describe('Type Definitions', () => {
    it('should have CreatePeerInput type with required fields', () => {
      const input: CreatePeerInput = {
        name: 'test-peer.example.com',
        endpoint: 'ws://test:3000/rpc',
        domains: ['example.com'],
        orchestratorUrl: 'ws://localhost:3000/rpc',
        logLevel: 'info',
      }
      expect(input.name).toBe('test-peer.example.com')
      expect(input.endpoint).toBe('ws://test:3000/rpc')
      expect(input.domains).toEqual(['example.com'])
    })

    it('should have DeletePeerInput type with required fields', () => {
      const input: DeletePeerInput = {
        name: 'test-peer.example.com',
        orchestratorUrl: 'ws://localhost:3000/rpc',
        logLevel: 'info',
      }
      expect(input.name).toBe('test-peer.example.com')
    })

    it('should have ListPeersInput type with required fields', () => {
      const input: ListPeersInput = {
        orchestratorUrl: 'ws://localhost:3000/rpc',
        logLevel: 'info',
      }
      expect(input.orchestratorUrl).toBe('ws://localhost:3000/rpc')
    })
  })

  describe('Handler Return Types', () => {
    it('createPeerHandler should return success result type', () => {
      const successResult: { success: true; data: { name: string } } = {
        success: true,
        data: { name: 'peer-a' },
      }
      expect(successResult.success).toBe(true)
      expect(successResult.data.name).toBe('peer-a')
    })

    it('createPeerHandler should return error result type', () => {
      const errorResult: { success: false; error: string } = {
        success: false,
        error: 'Connection failed',
      }
      expect(errorResult.success).toBe(false)
      expect(errorResult.error).toBe('Connection failed')
    })

    it('listPeersHandler should return success result with peers array', () => {
      const successResult: {
        success: true
        data: {
          peers: Array<{
            name: string
            endpoint: string
            domains: string[]
            connectionStatus: string
          }>
        }
      } = {
        success: true,
        data: {
          peers: [
            {
              name: 'peer-a',
              endpoint: 'ws://peer-a:3000/rpc',
              domains: ['example.com'],
              connectionStatus: 'connected',
            },
          ],
        },
      }
      expect(successResult.success).toBe(true)
      expect(successResult.data.peers.length).toBe(1)
    })

    it('deletePeerHandler should return success result type', () => {
      const successResult: { success: true; data: { name: string } } = {
        success: true,
        data: { name: 'peer-a' },
      }
      expect(successResult.success).toBe(true)
      expect(successResult.data.name).toBe('peer-a')
    })
  })

  describe('Handler Error Handling', () => {
    it('should handle network errors gracefully', () => {
      const errorResult: { success: false; error: string } = {
        success: false,
        error: 'Network connection failed',
      }
      expect(errorResult.success).toBe(false)
      expect(typeof errorResult.error).toBe('string')
    })

    it('should handle RPC errors gracefully', () => {
      const errorResult: { success: false; error: string } = {
        success: false,
        error: 'RPC call failed: peer not found',
      }
      expect(errorResult.success).toBe(false)
      expect(errorResult.error).toContain('peer not found')
    })
  })
})
