import { loadDefaultConfig } from '@catalyst/config'
import { catalystHonoServer } from '@catalyst/service'
import { StatusPageService } from './service.js'

const config = loadDefaultConfig({ serviceType: 'gateway' })
const statusPage = await StatusPageService.create({ config })

catalystHonoServer(statusPage.handler, {
  services: [statusPage],
  port: config.port,
}).start()
