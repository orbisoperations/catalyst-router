/**
 * Zenoh TAK Adapter — Subscriber/Consumer
 *
 * Uses zenohd in **client mode** to connect to a Zenoh router through the
 * Catalyst mesh TCP passthrough tunnel, demonstrating that native Zenoh
 * protocol traverses the Envoy tcp_proxy listeners without modification.
 *
 * Architecture:
 *   1. Bun app spawns zenohd as a client with REST plugin on localhost
 *   2. zenohd connects to the Envoy egress port using native Zenoh TCP protocol
 *   3. Envoy tunnels the connection: proxy-c -> proxy-b -> proxy-a -> zenoh-router:7447
 *   4. Bun app polls zenohd's local REST API to read subscribed data
 *
 * This separates concerns: zenohd handles the protocol, Bun handles the business logic.
 *
 * Environment variables:
 *   ZENOH_CONNECT       — Zenoh connect endpoint (default: tcp/envoy-proxy-c:10000)
 *   SUBSCRIBE_KEY       — Zenoh key expression to subscribe (default: demo/radar/tracks)
 *   POLL_INTERVAL_MS    — How often to poll for new data (default: 500)
 *   ZENOHD_BIN          — Path to zenohd binary (default: /usr/local/bin/zenohd)
 *   ZENOHD_REST_PORT    — Local REST plugin port (default: 8080)
 */

import { parseDataPacket, type DataPacket } from './data-packet.js'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

const ZENOH_CONNECT = process.env.ZENOH_CONNECT ?? 'tcp/envoy-proxy-c:10000'
const SUBSCRIBE_KEY = process.env.SUBSCRIBE_KEY ?? 'demo/radar/tracks'
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? '500', 10)
const ZENOHD_BIN = process.env.ZENOHD_BIN ?? '/usr/local/bin/zenohd'
const ZENOHD_REST_PORT = parseInt(process.env.ZENOHD_REST_PORT ?? '8080', 10)

console.log(`[tak-adapter] Zenoh connect:  ${ZENOH_CONNECT}`)
console.log(`[tak-adapter] Subscribe key:  ${SUBSCRIBE_KEY}`)
console.log(`[tak-adapter] Poll interval:  ${POLL_INTERVAL_MS}ms`)
console.log(`[tak-adapter] zenohd binary:  ${ZENOHD_BIN}`)
console.log(`[tak-adapter] REST port:      ${ZENOHD_REST_PORT}`)

let received = 0
let lastTimestamp = 0

function handlePacket(packet: DataPacket): void {
  // Deduplicate by timestamp
  if (packet.timestamp === lastTimestamp) return
  lastTimestamp = packet.timestamp

  received++
  const age = Date.now() - packet.timestamp
  if (received === 1 || received % 10 === 0) {
    console.log(
      `[tak-adapter] #${received} | lat=${packet.latitude.toFixed(4)} lon=${packet.longitude.toFixed(4)} alt=${packet.altitude} spd=${packet.speed} hdg=${packet.heading} age=${age}ms`
    )
  }
}

/**
 * Generate a zenoh config file for client mode with REST plugin.
 */
function generateZenohConfig(configPath: string): void {
  const config = {
    mode: 'client',
    connect: {
      endpoints: [ZENOH_CONNECT],
    },
    plugins: {
      rest: {
        http_port: ZENOHD_REST_PORT,
      },
    },
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2))
  console.log(`[tak-adapter] Generated zenoh config at ${configPath}`)
}

/**
 * Spawn zenohd in client mode.
 */
function startZenohd(configPath: string): ReturnType<typeof Bun.spawn> {
  console.log(`[tak-adapter] Spawning zenohd in client mode...`)

  const pluginDir = process.env.ZENOH_PLUGIN_SEARCH_DIR ?? '/usr/local/lib'
  const proc = Bun.spawn([ZENOHD_BIN, '-c', configPath, '--plugin-search-dir', pluginDir], {
    stdout: 'pipe',
    stderr: 'pipe',
  })

  // Stream zenohd logs to stdout with a prefix
  const logStream = (stream: ReadableStream<Uint8Array>, label: string): void => {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    const readLoop = async (): Promise<void> => {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const text = decoder.decode(value, { stream: true })
        for (const line of text.split('\n').filter(Boolean)) {
          console.log(`[zenohd:${label}] ${line}`)
        }
      }
    }
    readLoop().catch(() => {})
  }

  logStream(proc.stdout, 'out')
  logStream(proc.stderr, 'err')

  proc.exited.then((code) => {
    console.log(`[tak-adapter] zenohd exited with code ${code}`)
    if (code !== 0) {
      console.log('[tak-adapter] Restarting zenohd in 5 seconds...')
      setTimeout(() => startZenohd(configPath), 5000)
    }
  })

  return proc
}

/**
 * Wait for zenohd's REST API to become available.
 */
async function waitForRest(maxWaitMs = 120_000): Promise<void> {
  const url = `http://127.0.0.1:${ZENOHD_REST_PORT}/@/local`
  const start = Date.now()

  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(url)
      if (res.ok) {
        console.log(`[tak-adapter] zenohd REST API ready`)
        return
      }
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`zenohd REST API not ready after ${maxWaitMs}ms`)
}

/**
 * Poll zenohd REST API for subscribed data.
 */
async function pollLoop(): Promise<void> {
  const url = `http://127.0.0.1:${ZENOHD_REST_PORT}/${SUBSCRIBE_KEY}`
  console.log(`[tak-adapter] Polling ${url} every ${POLL_INTERVAL_MS}ms`)

  while (true) {
    try {
      const res = await fetch(url)
      if (res.ok) {
        const text = await res.text()
        if (text) {
          const packet = parseDataPacket(text)
          if (packet) {
            handlePacket(packet)
          }
        }
      }
    } catch {
      // zenohd may have restarted — keep polling
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }
}

// --- Main ---

const configDir = '/tmp/zenoh-tak'
mkdirSync(configDir, { recursive: true })
const configPath = join(configDir, 'config.json5')

generateZenohConfig(configPath)
const zenohProc = startZenohd(configPath)

try {
  await waitForRest()
  await pollLoop()
} catch (err) {
  console.error(`[tak-adapter] Fatal: ${err}`)
  zenohProc.kill()
  process.exit(1)
}

// Graceful shutdown
function shutdown(): void {
  console.log(`[tak-adapter] Shutting down (received ${received} packets total)`)
  zenohProc.kill()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
