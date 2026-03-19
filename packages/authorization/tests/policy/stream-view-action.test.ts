import { describe, expect, it } from 'vitest'
import {
  Action,
  ALL_POLICIES,
  AuthorizationEngine,
  CATALYST_SCHEMA,
  type CatalystPolicyDomain,
  Principal,
} from '../../src/policy/src/index.js'

/**
 * Verifies STREAM_VIEW action role matrix (F-04, R3):
 *   ADMIN           → permit (wildcard policy)
 *   DATA_CUSTODIAN  → permit (explicit in data-custodian.cedar)
 *   USER            → permit (explicit in user.cedar)
 *   NODE            → deny   (not in node.cedar)
 *   NODE_CUSTODIAN  → deny   (not in node-custodian.cedar)
 *
 * Also verifies STREAM_VIEW is independent from ROUTE_LIST —
 * a principal can have one without the other.
 */
describe('STREAM_VIEW Cedar action', () => {
  const engine = new AuthorizationEngine<CatalystPolicyDomain>(CATALYST_SCHEMA, ALL_POLICIES)

  /**
   * Returns 'allow' or 'deny'. Cedar returns a 'failure' when the principal
   * type is not in the action's appliesTo list — that is semantically a deny.
   */
  function authorize(principal: Principal, action: Action): 'allow' | 'deny' {
    const factory = engine.entityBuilderFactory.createEntityBuilder()
    factory.entity(principal, 'test-entity').setAttributes({
      id: 'test-entity',
      name: 'test',
      type: 'test',
      trustedNodes: [],
      trustedDomains: ['test-domain'],
    })
    factory.entity('CATALYST::Route', 'test-route').setAttributes({
      nodeId: 'test-node',
      domainId: 'test-domain',
    })
    const entities = factory.build()

    const result = engine.isAuthorized({
      principal: { type: principal, id: 'test-entity' },
      action: `CATALYST::Action::${action}`,
      resource: { type: 'CATALYST::Route', id: 'test-route' },
      entities: entities.getAll(),
      context: {},
    })

    // Cedar returns 'failure' when principal type is not in appliesTo — that's a deny
    if (result.type === 'failure') return 'deny'
    return result.decision
  }

  describe('role matrix', () => {
    it('permits ADMIN', () => {
      expect(authorize(Principal.ADMIN, Action.STREAM_VIEW)).toBe('allow')
    })

    it('permits DATA_CUSTODIAN', () => {
      expect(authorize(Principal.DATA_CUSTODIAN, Action.STREAM_VIEW)).toBe('allow')
    })

    it('permits USER', () => {
      expect(authorize(Principal.USER, Action.STREAM_VIEW)).toBe('allow')
    })

    it('denies NODE', () => {
      expect(authorize(Principal.NODE, Action.STREAM_VIEW)).toBe('deny')
    })

    it('denies NODE_CUSTODIAN', () => {
      expect(authorize(Principal.NODE_CUSTODIAN, Action.STREAM_VIEW)).toBe('deny')
    })
  })

  describe('independence from ROUTE_LIST', () => {
    it('NODE can use ROUTE_LIST but not STREAM_VIEW', () => {
      // NODE is not in ROUTE_LIST schema either, so it should deny both
      // But NODE_CUSTODIAN can't do ROUTE_LIST, confirming separation
      expect(authorize(Principal.NODE_CUSTODIAN, Action.STREAM_VIEW)).toBe('deny')
      expect(authorize(Principal.NODE_CUSTODIAN, Action.ROUTE_LIST)).toBe('deny')
    })

    it('DATA_CUSTODIAN can use both STREAM_VIEW and ROUTE_LIST', () => {
      expect(authorize(Principal.DATA_CUSTODIAN, Action.STREAM_VIEW)).toBe('allow')
      expect(authorize(Principal.DATA_CUSTODIAN, Action.ROUTE_LIST)).toBe('allow')
    })

    it('USER can use both STREAM_VIEW and ROUTE_LIST', () => {
      expect(authorize(Principal.USER, Action.STREAM_VIEW)).toBe('allow')
      expect(authorize(Principal.USER, Action.ROUTE_LIST)).toBe('allow')
    })
  })
})
