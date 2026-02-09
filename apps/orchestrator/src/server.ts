import { loadDefaultConfig } from '@catalyst/config'
import { catalystHonoServer } from '@catalyst/service'
import { websocket } from 'hono/bun'
import { OrchestratorService } from './service.js'

const config = loadDefaultConfig()
const orchestrator = await OrchestratorService.create({ config })

catalystHonoServer(orchestrator.handler, {
  services: [orchestrator],
  port: config.port,
  websocket,
}).start()
