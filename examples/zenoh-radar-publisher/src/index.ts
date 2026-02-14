/**
 * Zenoh Radar Publisher
 *
 * Generates fake radar DataPacket objects and publishes them to a Zenoh router
 * via its REST API. Designed to run alongside a Zenoh router on the same node.
 *
 * Environment variables:
 *   ZENOH_ROUTER_URL  — Zenoh router REST API base URL (default: http://zenoh-router:8000)
 *   PUBLISH_KEY       — Zenoh key expression to publish on (default: demo/radar/tracks)
 *   PUBLISH_INTERVAL_MS — Interval between publishes in ms (default: 1000)
 */

import { generateDataPacket } from './data-packet.js'

const ZENOH_ROUTER_URL = process.env.ZENOH_ROUTER_URL ?? 'http://zenoh-router:8000'
const PUBLISH_KEY = process.env.PUBLISH_KEY ?? 'demo/radar/tracks'
const PUBLISH_INTERVAL_MS = Number(process.env.PUBLISH_INTERVAL_MS) || 1000

console.log(`[radar-publisher] Zenoh router: ${ZENOH_ROUTER_URL}`)
console.log(`[radar-publisher] Publish key:  ${PUBLISH_KEY}`)
console.log(`[radar-publisher] Interval:     ${PUBLISH_INTERVAL_MS}ms`)

const publishUrl = `${ZENOH_ROUTER_URL}/${PUBLISH_KEY}`

async function waitForRouter(timeoutMs = 60_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${ZENOH_ROUTER_URL}/@/local`)
      if (res.ok) {
        console.log('[radar-publisher] Zenoh router is ready')
        return
      }
    } catch {
      // Router not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`Zenoh router not reachable at ${ZENOH_ROUTER_URL} after ${timeoutMs}ms`)
}

let published = 0

async function publish(): Promise<void> {
  const packet = generateDataPacket()
  try {
    const res = await fetch(publishUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(packet),
    })
    if (!res.ok) {
      console.error(`[radar-publisher] PUT failed: ${res.status} ${res.statusText}`)
      return
    }
    published++
    if (published === 1 || published % 10 === 0) {
      console.log(
        `[radar-publisher] Published ${published} packets (latest: lat=${packet.latitude.toFixed(4)}, lon=${packet.longitude.toFixed(4)}, alt=${packet.altitude})`
      )
    }
  } catch (err) {
    console.error(`[radar-publisher] Publish error: ${err}`)
  }
}

// Start
await waitForRouter()
console.log('[radar-publisher] Starting publish loop...')

const interval = setInterval(publish, PUBLISH_INTERVAL_MS)

// Graceful shutdown
function shutdown(): void {
  console.log(`[radar-publisher] Shutting down (published ${published} packets)`)
  clearInterval(interval)
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
