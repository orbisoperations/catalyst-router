import { loadDefaultConfig } from '@catalyst/config'
import { catalystHonoServer } from '@catalyst/service'
import { NodeService } from './service.js'

const config = loadDefaultConfig()
const node = await NodeService.create({ config })

catalystHonoServer(node.handler, {
  services: [node],
  port: config.port,
}).start()
