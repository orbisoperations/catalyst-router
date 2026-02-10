import { loadDefaultConfig } from '@catalyst/config'
import { catalystHonoServer } from '@catalyst/service'
import { websocket } from 'hono/bun'
import { GatewayService } from './service.js'

const config = loadDefaultConfig({ serviceType: 'gateway' })
const gateway = await GatewayService.create({ config })

catalystHonoServer(gateway.handler, {
  services: [gateway],
  port: config.port,
  websocket,
}).start()
