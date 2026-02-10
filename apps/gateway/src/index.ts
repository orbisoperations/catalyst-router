import { loadDefaultConfig } from '@catalyst/config'
import { catalystHonoServer } from '@catalyst/service'
import { GatewayService } from './service.js'

const config = loadDefaultConfig()
const gateway = await GatewayService.create({ config })

console.log('GATEWAY_STARTED')

catalystHonoServer(gateway.handler, {
  services: [gateway],
  port: config.port,
}).start()
