import type { AuthorizationEngine } from '../authorization-engine.js'
import adminPolicy from './admin.cedar' with { type: 'text' }
import dataCustodianPolicy from './data-custodian.cedar' with { type: 'text' }
import type { Action, IBGPEntity, PeerEntity, Role, RouteEntity } from './models.js'
import nodeCustodianPolicy from './node-custodian.cedar' with { type: 'text' }
import nodePolicy from './node.cedar' with { type: 'text' }
import CATALYST_SCHEMA from './schema.schemacedar' with { type: 'text' }
import telemetryExporterPolicy from './telemetry-exporter.cedar' with { type: 'text' }
import userPolicy from './user.cedar' with { type: 'text' }

export {
  adminPolicy,
  CATALYST_SCHEMA,
  dataCustodianPolicy,
  nodeCustodianPolicy,
  nodePolicy,
  telemetryExporterPolicy,
  userPolicy,
}

/**
 * All predefined Catalyst policies combined into a single Cedar string.
 */
export const ALL_POLICIES = [
  adminPolicy,
  nodePolicy,
  nodeCustodianPolicy,
  dataCustodianPolicy,
  userPolicy,
  telemetryExporterPolicy,
].join('\n')

/**
 * Catalyst Policy Domain definition.
 * Aligns Cedar principals and actions with TypeScript types.
 */
export type CatalystPolicyDomain = [
  {
    Namespace: 'CATALYST'
    Actions: Action
    Entities: {
      [Role.ADMIN]: Record<string, unknown>
      [Role.NODE]: Record<string, unknown>
      [Role.DATA_CUSTODIAN]: Record<string, unknown>
      [Role.NODE_CUSTODIAN]: Record<string, unknown>
      [Role.USER]: Record<string, unknown>
      [Role.TELEMETRY_EXPORTER]: Record<string, unknown>
      IBGP: IBGPEntity
      Peer: PeerEntity
      Route: RouteEntity
      Token: Record<string, unknown>
      AdminPanel: Record<string, unknown>
      Collector: Record<string, unknown>
      Gateway: Record<string, unknown>
    }
  },
]

export type CatalystPolicyEngine = AuthorizationEngine<CatalystPolicyDomain>

export * from './models.js'
