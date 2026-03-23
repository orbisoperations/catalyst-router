import { loadDefaultConfig } from '@catalyst/config'
import { catalystHonoServer } from '@catalyst/service'
import { VideoStreamService } from './service.js'
import { loadVideoConfig } from './config.js'

const config = loadDefaultConfig({ serviceType: 'video' })
const videoConfig = loadVideoConfig()

const video = await VideoStreamService.create({ config, videoConfig })

catalystHonoServer(video.handler, {
  services: [video],
  port: config.port,
}).start()
