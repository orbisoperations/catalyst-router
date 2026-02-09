import { CatalystNodeBus } from './orchestrator.js'

export { CatalystNodeBus }
export { OrchestratorService } from './service.js'

// Re-export routing types for backward compatibility
export {
  DataChannelDefinitionSchema as ServiceDefinitionSchema,
  type PeerInfo,
  type InternalRoute,
  type DataChannelDefinition,
} from '@catalyst/routing'
