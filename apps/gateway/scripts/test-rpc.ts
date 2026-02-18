import { newWebSocketRpcSession } from 'capnweb'
import type { GatewayPublicApi } from '../src/rpc/server.js'

async function main() {
  console.log('Connecting to RPC server...')
  const port = process.env.PORT || 4000
  const ws = new WebSocket(`ws://localhost:${port}/api`)

  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve())
    ws.addEventListener('error', (_event) => reject(new Error('WebSocket connection failed')))
  })

  console.log('Connected. Starting RPC session...')

  // As a client, we don't expose any local API, so localMain is undefined.
  // We get back a stub for the remote main (the GatewayRpcServer).
  // We cast it to 'any' because we don't have the shared type definition file setup for the client script perfectly here,
  // but we know it has updateConfig.
  const gateway = newWebSocketRpcSession(ws as unknown as WebSocket) as unknown as GatewayPublicApi

  console.log('Requesting config client...')
  const token = process.env.CATALYST_AUTH_TOKEN || ''

  try {
    const configResult = await gateway.getConfigClient(token)
    if (!configResult.success) {
      console.error('[error] Config client auth failed:', configResult.error)
      process.exit(1)
    }

    console.log('Sending configuration update...')
    const result = await configResult.client.updateConfig({
      services: [
        {
          name: 'countries',
          url: 'https://countries.trevorblades.com/',
        },
      ],
    })

    console.log('Result:', result)

    if (result.success) {
      console.log('[ok] Configuration update successful!')
    } else {
      console.error('[error] Configuration update failed:', result.error)
      process.exit(1)
    }
  } catch (error) {
    console.error('[error] RPC Call failed:', error)
    process.exit(1)
  } finally {
    ws.close()
  }
}

main().catch((err) => {
  console.error('Unhandled error:', err)
  process.exit(1)
})
