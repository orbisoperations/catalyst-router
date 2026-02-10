import { loadDefaultConfig } from '@catalyst/config'
import { catalystHonoServer } from '@catalyst/service'
import { OrchestratorService, websocket } from './service.js'

const config = loadDefaultConfig()
const orchestrator = await OrchestratorService.create({ config })

if (!websocket) {
  throw new Error('WebSocket handler is required')
}
catalystHonoServer(orchestrator.handler, {
  services: [orchestrator],
  port: config.port,
  websocket,
}).start()
