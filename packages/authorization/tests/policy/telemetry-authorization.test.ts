import { describe, expect, it } from 'bun:test'
import { AuthorizationEngine } from '../../src/policy/src/authorization-engine.js'
import type { CatalystPolicyDomain } from '../../src/policy/src/definitions/index.js'
import {
  Action,
  ALL_POLICIES,
  CATALYST_SCHEMA,
  Role,
} from '../../src/policy/src/definitions/index.js'
import { EntityBuilderFactory } from '../../src/policy/src/entity-builder.js'

describe('Telemetry Authorization', () => {
  const engine = new AuthorizationEngine<CatalystPolicyDomain>(CATALYST_SCHEMA, ALL_POLICIES)
  const factory = new EntityBuilderFactory<CatalystPolicyDomain>()

  factory
    .registerMapper('CATALYST::TELEMETRY_EXPORTER', (data: Record<string, unknown>) => ({
      id: data.id as string,
      attrs: data,
    }))
    .registerMapper('CATALYST::ADMIN', (data: Record<string, unknown>) => ({
      id: data.id as string,
      attrs: data,
    }))
    .registerMapper('CATALYST::USER', (data: Record<string, unknown>) => ({
      id: data.id as string,
      attrs: data,
    }))
    .registerMapper('CATALYST::Collector', (data: Record<string, unknown>) => ({
      id: data.id as string,
      attrs: { nodeId: data.nodeId, domainId: data.domainId },
    }))

  describe('Cedar schema validation', () => {
    it('should validate policies with TELEMETRY_EXPORTER, Collector, and TELEMETRY_EXPORT', () => {
      const valid = engine.validatePolicies()
      expect(valid).toBe(true)
    })

    it('should include TELEMETRY_EXPORTER role in Role enum', () => {
      expect(Role.TELEMETRY_EXPORTER).toBe('TELEMETRY_EXPORTER')
    })

    it('should include TELEMETRY_EXPORT action in Action enum', () => {
      expect(Action.TELEMETRY_EXPORT).toBe('TELEMETRY_EXPORT')
    })
  })

  describe('Cedar policy evaluation', () => {
    it('should permit TELEMETRY_EXPORT for TELEMETRY_EXPORTER with matching trust', () => {
      const builder = factory.createEntityBuilder()
      builder.add('CATALYST::TELEMETRY_EXPORTER', {
        id: 'telemetry-exporter',
        name: 'Telemetry Exporter',
        type: 'service',
        trustedNodes: [],
        trustedDomains: [],
      })
      builder.add('CATALYST::Collector', {
        id: 'collector-1',
        nodeId: 'node-1',
        domainId: 'domain-1',
      })
      const entities = builder.build()

      const result = engine.isAuthorized({
        principal: entities.entityRef('CATALYST::TELEMETRY_EXPORTER', 'telemetry-exporter'),
        action: 'CATALYST::Action::TELEMETRY_EXPORT',
        resource: entities.entityRef('CATALYST::Collector', 'collector-1'),
        entities: entities.getAll(),
        context: {},
      })

      expect(result.type).toBe('evaluated')
      if (result.type === 'evaluated') {
        expect(result.decision).toBe('allow')
      }
    })

    it('should permit TELEMETRY_EXPORT for ADMIN principal', () => {
      const builder = factory.createEntityBuilder()
      builder.add('CATALYST::ADMIN', {
        id: 'admin-1',
        name: 'Admin',
        type: 'user',
        trustedNodes: [],
        trustedDomains: [],
      })
      builder.add('CATALYST::Collector', {
        id: 'collector-1',
        nodeId: 'node-1',
        domainId: 'domain-1',
      })
      const entities = builder.build()

      const result = engine.isAuthorized({
        principal: entities.entityRef('CATALYST::ADMIN', 'admin-1'),
        action: 'CATALYST::Action::TELEMETRY_EXPORT',
        resource: entities.entityRef('CATALYST::Collector', 'collector-1'),
        entities: entities.getAll(),
        context: {},
      })

      expect(result.type).toBe('evaluated')
      if (result.type === 'evaluated') {
        expect(result.decision).toBe('allow')
      }
    })

    it('should reject TELEMETRY_EXPORT for USER principal (not in appliesTo)', () => {
      const builder = factory.createEntityBuilder()
      builder.add('CATALYST::USER', {
        id: 'user-1',
        name: 'Regular User',
        type: 'user',
        trustedNodes: [],
        trustedDomains: [],
      })
      builder.add('CATALYST::Collector', {
        id: 'collector-1',
        nodeId: 'node-1',
        domainId: 'domain-1',
      })
      const entities = builder.build()

      const result = engine.isAuthorized({
        principal: entities.entityRef('CATALYST::USER', 'user-1'),
        action: 'CATALYST::Action::TELEMETRY_EXPORT',
        resource: entities.entityRef('CATALYST::Collector', 'collector-1'),
        entities: entities.getAll(),
        context: {},
      })

      // Cedar schema rejects at validation level — USER is not in TELEMETRY_EXPORT's appliesTo
      expect(result.type).toBe('failure')
    })

    it('should permit TELEMETRY_EXPORT when trustedDomains matches', () => {
      const builder = factory.createEntityBuilder()
      builder.add('CATALYST::TELEMETRY_EXPORTER', {
        id: 'telemetry-exporter',
        name: 'Telemetry Exporter',
        type: 'service',
        trustedNodes: [],
        trustedDomains: ['domain-1'],
      })
      builder.add('CATALYST::Collector', {
        id: 'collector-1',
        nodeId: 'node-1',
        domainId: 'domain-1',
      })
      const entities = builder.build()

      const result = engine.isAuthorized({
        principal: entities.entityRef('CATALYST::TELEMETRY_EXPORTER', 'telemetry-exporter'),
        action: 'CATALYST::Action::TELEMETRY_EXPORT',
        resource: entities.entityRef('CATALYST::Collector', 'collector-1'),
        entities: entities.getAll(),
        context: {},
      })

      expect(result.type).toBe('evaluated')
      if (result.type === 'evaluated') {
        expect(result.decision).toBe('allow')
      }
    })

    it('should deny TELEMETRY_EXPORT when trustedDomains does not match', () => {
      const builder = factory.createEntityBuilder()
      builder.add('CATALYST::TELEMETRY_EXPORTER', {
        id: 'telemetry-exporter',
        name: 'Telemetry Exporter',
        type: 'service',
        trustedNodes: [],
        trustedDomains: ['other-domain'],
      })
      builder.add('CATALYST::Collector', {
        id: 'collector-1',
        nodeId: 'node-1',
        domainId: 'domain-1',
      })
      const entities = builder.build()

      const result = engine.isAuthorized({
        principal: entities.entityRef('CATALYST::TELEMETRY_EXPORTER', 'telemetry-exporter'),
        action: 'CATALYST::Action::TELEMETRY_EXPORT',
        resource: entities.entityRef('CATALYST::Collector', 'collector-1'),
        entities: entities.getAll(),
        context: {},
      })

      expect(result.type).toBe('evaluated')
      if (result.type === 'evaluated') {
        expect(result.decision).toBe('deny')
      }
    })
  })
})
