import { describe, test, expect, beforeAll } from 'bun:test'
import { AuthorizationEngine } from '../src/policy/src/authorization-engine.js'
import {
  CATALYST_SCHEMA,
  ALL_POLICIES,
  type CatalystPolicyDomain,
} from '../src/policy/src/definitions/index.js'

/**
 * Cedar stream policy evaluation tests.
 *
 * WHY a role x action matrix:
 * The Cedar schema's `appliesTo` clauses structurally restrict which principals
 * can even attempt an action. The policy `permit` rules then further constrain
 * based on trusted domains/nodes. This test verifies both layers:
 * - Structural: Can this principal type invoke this action? (appliesTo)
 * - Policy: Does a permit rule grant access? (when clause)
 *
 * WHY raw entity arrays instead of EntityBuilder:
 * Cedar WASM expects Set<String> attributes as plain JSON arrays.
 * The EntityBuilder's .setAttributes() with JS Set objects doesn't
 * serialize correctly for cedar-wasm. Raw arrays work.
 */

function makeEntities(
  principalType: string,
  principalId: string,
  opts: { trustedDomains: string[]; trustedNodes: string[] }
) {
  return [
    {
      uid: { type: principalType, id: principalId },
      attrs: {
        id: principalId,
        name: principalId,
        type: principalType.split('::').pop()!,
        trustedDomains: opts.trustedDomains,
        trustedNodes: opts.trustedNodes,
      },
      parents: [],
    },
    {
      uid: { type: 'CATALYST::Stream', id: 'test-stream' },
      attrs: {
        streamId: 'test-stream',
        sourceNode: 'field-node-1',
        domainId: 'domain-1',
        nodeId: 'field-node-1',
      },
      parents: [],
    },
  ]
}

describe('Cedar Stream Policies', () => {
  let engine: AuthorizationEngine<CatalystPolicyDomain>

  beforeAll(() => {
    engine = new AuthorizationEngine<CatalystPolicyDomain>(CATALYST_SCHEMA, ALL_POLICIES)
    const valid = engine.validatePolicies({ failOnWarnings: false })
    expect(valid).toBe(true)
  })

  function evaluate(
    principalType: string,
    principalId: string,
    action: string,
    trustedDomains: string[] = ['domain-1'],
    trustedNodes: string[] = []
  ): { allowed: boolean; type: string } {
    const entities = makeEntities(principalType, principalId, {
      trustedDomains,
      trustedNodes,
    })

    const result = engine.isAuthorized({
      principal: { type: principalType, id: principalId } as any,
      action: `CATALYST::Action::${action}` as any,
      resource: { type: 'CATALYST::Stream', id: 'test-stream' } as any,
      entities: entities as any,
      context: {},
    })

    if (result.type === 'evaluated') {
      return { allowed: result.allowed, type: 'evaluated' }
    }
    return { allowed: false, type: 'failure' }
  }

  describe('ADMIN — has all permissions', () => {
    test('ADMIN can STREAM_PUBLISH', () => {
      const result = evaluate('CATALYST::ADMIN', 'admin-1', 'STREAM_PUBLISH')
      expect(result.type).toBe('evaluated')
      expect(result.allowed).toBe(true)
    })

    test('ADMIN can STREAM_SUBSCRIBE', () => {
      const result = evaluate('CATALYST::ADMIN', 'admin-1', 'STREAM_SUBSCRIBE')
      expect(result.type).toBe('evaluated')
      expect(result.allowed).toBe(true)
    })
  })

  describe('NODE — no stream permissions', () => {
    test('NODE cannot STREAM_PUBLISH (not in appliesTo)', () => {
      const result = evaluate('CATALYST::NODE', 'node-1', 'STREAM_PUBLISH')
      expect(result.allowed).toBe(false)
    })

    test('NODE cannot STREAM_SUBSCRIBE (not in appliesTo)', () => {
      const result = evaluate('CATALYST::NODE', 'node-1', 'STREAM_SUBSCRIBE')
      expect(result.allowed).toBe(false)
    })
  })

  describe('NODE_CUSTODIAN — no stream permissions', () => {
    test('NODE_CUSTODIAN cannot STREAM_PUBLISH (not in appliesTo)', () => {
      const result = evaluate('CATALYST::NODE_CUSTODIAN', 'nc-1', 'STREAM_PUBLISH')
      expect(result.allowed).toBe(false)
    })

    test('NODE_CUSTODIAN cannot STREAM_SUBSCRIBE (not in appliesTo)', () => {
      const result = evaluate('CATALYST::NODE_CUSTODIAN', 'nc-1', 'STREAM_SUBSCRIBE')
      expect(result.allowed).toBe(false)
    })
  })

  describe('DATA_CUSTODIAN — can publish and subscribe', () => {
    test('DATA_CUSTODIAN can STREAM_PUBLISH in trusted domain', () => {
      const result = evaluate('CATALYST::DATA_CUSTODIAN', 'dc-1', 'STREAM_PUBLISH')
      expect(result.type).toBe('evaluated')
      expect(result.allowed).toBe(true)
    })

    test('DATA_CUSTODIAN can STREAM_SUBSCRIBE in trusted domain', () => {
      const result = evaluate('CATALYST::DATA_CUSTODIAN', 'dc-1', 'STREAM_SUBSCRIBE')
      expect(result.type).toBe('evaluated')
      expect(result.allowed).toBe(true)
    })

    test('DATA_CUSTODIAN denied STREAM_PUBLISH outside trusted domain', () => {
      const result = evaluate('CATALYST::DATA_CUSTODIAN', 'dc-1', 'STREAM_PUBLISH', [
        'other-domain',
      ])
      expect(result.type).toBe('evaluated')
      expect(result.allowed).toBe(false)
    })
  })

  describe('USER — can subscribe only', () => {
    test('USER can STREAM_SUBSCRIBE in trusted domain', () => {
      const result = evaluate('CATALYST::USER', 'user-1', 'STREAM_SUBSCRIBE')
      expect(result.type).toBe('evaluated')
      expect(result.allowed).toBe(true)
    })

    test('USER cannot STREAM_PUBLISH (not in appliesTo)', () => {
      const result = evaluate('CATALYST::USER', 'user-1', 'STREAM_PUBLISH')
      expect(result.allowed).toBe(false)
    })

    test('USER denied STREAM_SUBSCRIBE outside trusted domain', () => {
      const result = evaluate('CATALYST::USER', 'user-1', 'STREAM_SUBSCRIBE', ['other-domain'])
      expect(result.type).toBe('evaluated')
      expect(result.allowed).toBe(false)
    })
  })

  describe('trustedNodes constraint', () => {
    test('DATA_CUSTODIAN with specific trustedNodes — matches stream nodeId → allowed', () => {
      const result = evaluate(
        'CATALYST::DATA_CUSTODIAN',
        'dc-1',
        'STREAM_PUBLISH',
        ['domain-1'],
        ['field-node-1']
      )
      expect(result.allowed).toBe(true)
    })

    test('DATA_CUSTODIAN with specific trustedNodes — does not match stream nodeId → denied', () => {
      const result = evaluate(
        'CATALYST::DATA_CUSTODIAN',
        'dc-1',
        'STREAM_PUBLISH',
        ['domain-1'],
        ['other-node']
      )
      expect(result.allowed).toBe(false)
    })
  })
})
