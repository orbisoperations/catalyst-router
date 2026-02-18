import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AuthorizationEngine } from '../authorization-engine.js'
import type { Action, IBGPEntity, PeerEntity, Role, RouteEntity } from './models.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const cedar = (name: string): string => readFileSync(join(__dirname, name), 'utf-8')

const adminPolicy = cedar('admin.cedar')
const dataCustodianPolicy = cedar('data-custodian.cedar')
const nodeCustodianPolicy = cedar('node-custodian.cedar')
const nodePolicy = cedar('node.cedar')
const CATALYST_SCHEMA = cedar('schema.cedar')
const userPolicy = cedar('user.cedar')

export {
  adminPolicy,
  CATALYST_SCHEMA,
  dataCustodianPolicy,
  nodeCustodianPolicy,
  nodePolicy,
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
      IBGP: IBGPEntity
      Peer: PeerEntity
      Route: RouteEntity
      Token: Record<string, unknown>
      AdminPanel: Record<string, unknown>
    }
  },
]

export type CatalystPolicyEngine = AuthorizationEngine<CatalystPolicyDomain>

export * from './models.js'
