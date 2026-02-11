import { CatalystNodeBus, type PublicApi } from './orchestrator.js'

export { OrchestratorService } from './service.js'
export { CatalystNodeBus, type PublicApi as OrchestratorPublicApi }

// Re-export routing types for backward compatibility
export {
  DataChannelDefinitionSchema as ServiceDefinitionSchema,
  type DataChannelDefinition,
  type InternalRoute,
  type PeerInfo,
} from '@catalyst/routing'
