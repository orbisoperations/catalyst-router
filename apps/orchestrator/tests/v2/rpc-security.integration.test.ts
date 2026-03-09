/**
 * Integration test: RPC security properties.
 *
 * Verifies security-relevant behaviors that are important enough to warrant
 * explicit regression tests:
 * - listPeers strips peerToken from response (INT-07)
 * - listRoutes strips peerToken from internal route peer records
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { SignJWT } from 'jose'
import { OrchestratorBus } from '../../src/v2/bus.js'
import { MockPeerTransport } from '../../src/v2/transport.js'
import { createNetworkClient, createDataChannelClient } from '../../src/v2/rpc.js'
import type { TokenValidator } from '../../src/v2/rpc.js'
import { Actions } from '@catalyst/routing/v2'
import type { OrchestratorConfig } from '../../src/v1/types.js'
import type { PeerInfo } from '@catalyst/routing/v2'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const config: OrchestratorConfig = {
  node: {
    name: 'node-a',
    endpoint: 'ws://node-a:4000',
    domains: ['security.local'],
  },
}

const peerInfo: PeerInfo = {
  name: 'node-b',
  endpoint: 'ws://node-b:4000',
  domains: ['security.local'],
}

const routeAlpha = {
  name: 'alpha',
  protocol: 'http' as const,
  endpoint: 'http://alpha:8080',
}

const allowAllValidator: TokenValidator = {
  async validateToken() {
    return { valid: true }
  },
}

const TEST_SECRET = new TextEncoder().encode('test-secret-for-jwt-signing')

async function makeJwt(sub: string): Promise<string> {
  return new SignJWT({ sub }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().sign(TEST_SECRET)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RPC security: peerToken not leaked', () => {
  let bus: OrchestratorBus

  beforeEach(async () => {
    bus = new OrchestratorBus({
      config,
      transport: new MockPeerTransport(),
    })

    // Add peer via LocalPeerCreate
    await bus.dispatch({ action: Actions.LocalPeerCreate, data: peerInfo })

    // Open with a peerToken (set via InternalProtocolOpen which stores the token)
    const peerJwt = await makeJwt('node-b')
    await bus.dispatch({
      action: Actions.InternalProtocolOpen,
      data: { peerInfo, peerToken: peerJwt },
    })
  })

  it('listPeers does not expose peerToken in response', async () => {
    const result = await createNetworkClient(bus, 'any-token', allowAllValidator)
    if (!result.success) throw new Error('unexpected')

    const peers = await result.client.listPeers()
    expect(peers).toHaveLength(1)
    expect(peers[0].name).toBe('node-b')

    // peerToken must not be present
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((peers[0] as any).peerToken).toBeUndefined()
  })

  it('listRoutes does not expose peerToken on internal route peer records', async () => {
    // Connect peer so we can receive internal routes
    await bus.dispatch({
      action: Actions.InternalProtocolConnected,
      data: { peerInfo },
    })
    await bus.dispatch({
      action: Actions.InternalProtocolUpdate,
      data: {
        peerInfo,
        update: {
          updates: [
            {
              action: 'add',
              route: routeAlpha,
              nodePath: ['node-b'],
              originNode: 'node-b',
            },
          ],
        },
      },
    })

    const result = await createDataChannelClient(bus, 'any-token', allowAllValidator)
    if (!result.success) throw new Error('unexpected')

    const routes = await result.client.listRoutes()
    expect(routes.internal).toHaveLength(1)

    // The internal route's peer record must not expose peerToken
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((routes.internal[0].peer as any).peerToken).toBeUndefined()
  })
})
