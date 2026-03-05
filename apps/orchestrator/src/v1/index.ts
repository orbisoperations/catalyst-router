export {
  CatalystNodeBus,
  ConnectionPool,
  getHttpPeerSession,
  getWebSocketPeerSession,
  type PublicApi,
  type NetworkClient,
  type DataChannel,
  type IBGPClient,
  type PeerInfo,
  type InternalRoute,
} from './orchestrator.js'

export { OrchestratorService } from './service.js'

export {
  OrchestratorConfigSchema,
  type OrchestratorConfig,
  type StateResult,
  type NotificationResult,
} from './types.js'

// Re-export routing types for backward compatibility
export {
  DataChannelDefinitionSchema as ServiceDefinitionSchema,
  type DataChannelDefinition,
} from '@catalyst/routing/v1'
