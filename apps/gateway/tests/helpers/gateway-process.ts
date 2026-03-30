import { loadDefaultConfig } from '@catalyst/config'
import { catalystHonoServer } from '@catalyst/service'
import { GatewayService } from '../../src/service.js'

async function main() {
  const config = loadDefaultConfig({ serviceType: 'gateway' })
  config.port = 0

  const gateway = await GatewayService.create({ config })
  const server = catalystHonoServer(gateway.handler, {
    services: [gateway],
    port: 0,
  })

  await server.start()
  console.log(`GATEWAY_TEST_PORT=${server.port}`)
}

void main().catch((error: unknown) => {
  console.error('GATEWAY_TEST_START_FAILED')
  console.error(error)
  process.exit(1)
})
