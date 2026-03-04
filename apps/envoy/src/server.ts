import { loadDefaultConfig } from '@catalyst/config'
import { catalystHonoServer } from '@catalyst/service'
import { EnvoyService } from './service.js'

const config = loadDefaultConfig({ serviceType: 'envoy' })
const envoy = await EnvoyService.create({ config })

catalystHonoServer(envoy.handler, {
  services: [envoy],
  port: config.port,
}).start()
