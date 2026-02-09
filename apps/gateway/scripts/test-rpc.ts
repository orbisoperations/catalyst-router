import { newWebSocketRpcSession } from 'capnweb'

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
  const gateway = newWebSocketRpcSession(ws as unknown as WebSocket) as unknown as {
    updateConfig: (config: unknown) => Promise<{ success: boolean; error?: string }>
  }

  console.log('Sending configuration update...')

  try {
    // Call the remote method
    // Note: in Cap'n Web, we await the result.
    const result = await gateway.updateConfig({
      services: [
        {
          name: 'countries',
          url: 'https://countries.trevorblades.com/',
        },
      ],
    })

    console.log('Result:', result)

    if (result.success) {
      console.log('✅ Configuration update successful!')
    } else {
      console.error('❌ Configuration update failed:', result.error)
      process.exit(1)
    }
  } catch (error) {
    console.error('❌ RPC Call failed:', error)
    process.exit(1)
  } finally {
    ws.close()
  }
}

main().catch((err) => {
  console.error('Unhandled error:', err)
  process.exit(1)
})
