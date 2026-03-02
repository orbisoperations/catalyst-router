import { loadDefaultConfig } from '@catalyst/config'
import { catalystHonoServer } from '@catalyst/service'
import { VideoService } from './service.js'

const config = loadDefaultConfig({ serviceType: 'video' })
const video = await VideoService.create({ config })

catalystHonoServer(video.handler, {
  services: [video],
  port: config.port,
}).start()
