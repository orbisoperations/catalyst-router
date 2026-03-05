import { loadDefaultConfig } from '@catalyst/config'
import { catalystHonoServer } from '@catalyst/service'
import { OrchestratorService } from './v1/service.js'

const config = loadDefaultConfig()
const orchestrator = await OrchestratorService.create({ config })

catalystHonoServer(orchestrator.handler, {
  services: [orchestrator],
  port: config.port,
}).start()
