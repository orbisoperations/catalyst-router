#!/usr/bin/env bun
/**
 * init.ts — Post-startup initialization for the Zenoh 3-node demo.
 *
 * Mirrors a realistic Catalyst deployment bootstrap:
 *   1. Wait for per-node auth services to be healthy
 *   2. Extract system admin tokens from each auth service's logs
 *   3. Wait for orchestrators to be healthy
 *   4. Mint peer tokens (each auth mints NODE tokens for remote peers)
 *   5. Establish BGP peering with peer tokens: A <-> B, B <-> C
 *   6. Create the Zenoh TCP route on Node A
 *   7. Wait for xDS propagation (Envoy listeners on all nodes)
 *
 * Uses CLI handlers from @catalyst/cli — same code path as the real CLI tool.
 *
 * Usage:
 *   bun run demo/zenoh-tak/init.ts
 */

import { mintTokenHandler } from '../../apps/cli/src/handlers/auth-token-handlers.js'
import {
  createPeerHandler,
  listPeersHandler,
} from '../../apps/cli/src/handlers/node-peer-handlers.js'
import { createRouteHandler } from '../../apps/cli/src/handlers/node-route-handlers.js'

// ---------------------------------------------------------------------------
// Configuration — must match docker-compose.yaml service names and ports
// ---------------------------------------------------------------------------

const DOMAIN = 'somebiz.local.io'

const NODES = {
  a: {
    id: `node-a.${DOMAIN}`,
    authUrl: 'ws://localhost:5050/rpc',
    orchUrl: 'ws://localhost:3001/rpc',
    orchInternal: 'ws://orch-a:3000/rpc',
    healthUrl: 'http://localhost:3001/health',
    authHealthUrl: 'http://localhost:5050/health',
    envoyAdmin: 'http://localhost:9901',
  },
  b: {
    id: `node-b.${DOMAIN}`,
    authUrl: 'ws://localhost:5051/rpc',
    orchUrl: 'ws://localhost:3002/rpc',
    orchInternal: 'ws://orch-b:3000/rpc',
    healthUrl: 'http://localhost:3002/health',
    authHealthUrl: 'http://localhost:5051/health',
    envoyAdmin: 'http://localhost:9902',
  },
  c: {
    id: `node-c.${DOMAIN}`,
    authUrl: 'ws://localhost:5052/rpc',
    orchUrl: 'ws://localhost:3003/rpc',
    orchInternal: 'ws://orch-c:3000/rpc',
    healthUrl: 'http://localhost:3003/health',
    authHealthUrl: 'http://localhost:5052/health',
    envoyAdmin: 'http://localhost:9903',
  },
} as const

const COMPOSE_FILE = 'demo/zenoh-tak/docker-compose.yaml'

const ZENOH_ROUTE = {
  name: 'zenoh-router',
  protocol: 'tcp' as const,
  endpoint: 'http://zenoh-router:7447',
}

const HEALTH_TIMEOUT = 60_000
const PEER_TIMEOUT = 30_000
const XDS_TIMEOUT = 60_000

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string): void {
  const ts = new Date().toISOString().split('T')[1].replace('Z', '')
  console.log(`[${ts}] ${msg}`)
}

function fail(msg: string): never {
  console.error(`\nFATAL: ${msg}`)
  process.exit(1)
}

async function waitForHealth(
  url: string,
  label: string,
  timeoutMs = HEALTH_TIMEOUT
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url)
      if (res.ok) {
        log(`${label} healthy`)
        return
      }
    } catch {
      // not ready yet
    }
    await Bun.sleep(1000)
  }
  fail(
    `${label} did not become healthy within ${timeoutMs / 1000}s — is the compose stack running?`
  )
}

async function extractSystemToken(authService: string): Promise<string> {
  const proc = Bun.spawn(['docker', 'compose', '-f', COMPOSE_FILE, 'logs', authService], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = await new Response(proc.stdout).text()
  await proc.exited

  const match = stdout.match(/System Admin Token minted:\s*(\S+)/)
  if (!match) {
    fail(
      `Could not find system token in ${authService} logs.\n` +
        `Try: docker compose -f ${COMPOSE_FILE} logs ${authService} | grep "System Admin Token"`
    )
  }
  return match[1]
}

async function waitForPeerConnected(
  orchUrl: string,
  token: string,
  peerName: string,
  timeoutMs = PEER_TIMEOUT
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const result = await listPeersHandler({ orchestratorUrl: orchUrl, token })
    if (result.success) {
      const peer = result.data.peers.find((p) => p.name === peerName)
      if (peer && peer.connectionStatus === 'connected') return
    }
    await Bun.sleep(500)
  }
  fail(`Peer ${peerName} did not connect within ${timeoutMs / 1000}s`)
}

async function waitForListener(
  adminUrl: string,
  listenerName: string,
  label: string,
  timeoutMs = XDS_TIMEOUT
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${adminUrl}/listeners?format=json`)
      const text = await res.text()
      if (text.includes(listenerName)) {
        log(`${label}: listener '${listenerName}' ready`)
        return
      }
    } catch {
      // Envoy not ready yet
    }
    await Bun.sleep(500)
  }
  fail(`${label}: timed out waiting for listener '${listenerName}' (${timeoutMs / 1000}s)`)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log()
  console.log('='.repeat(60))
  console.log('  Zenoh TAK 3-Node Demo — Initialization')
  console.log('='.repeat(60))
  console.log()

  // ── 1. Wait for auth services ──────────────────────────────────
  log('Step 1/7: Waiting for auth services to be healthy...')
  await Promise.all([
    waitForHealth(NODES.a.authHealthUrl, 'auth-a'),
    waitForHealth(NODES.b.authHealthUrl, 'auth-b'),
    waitForHealth(NODES.c.authHealthUrl, 'auth-c'),
  ])

  // ── 2. Extract system tokens ──────────────────────────────────
  log('Step 2/7: Extracting system admin tokens from auth services...')
  const [systemTokenA, systemTokenB, systemTokenC] = await Promise.all([
    extractSystemToken('auth-a'),
    extractSystemToken('auth-b'),
    extractSystemToken('auth-c'),
  ])
  log(`  auth-a token: ${systemTokenA.substring(0, 20)}...`)
  log(`  auth-b token: ${systemTokenB.substring(0, 20)}...`)
  log(`  auth-c token: ${systemTokenC.substring(0, 20)}...`)

  // ── 3. Wait for orchestrators ──────────────────────────────────
  log('Step 3/7: Waiting for orchestrators to be healthy...')
  await Promise.all([
    waitForHealth(NODES.a.healthUrl, 'orch-a'),
    waitForHealth(NODES.b.healthUrl, 'orch-b'),
    waitForHealth(NODES.c.healthUrl, 'orch-c'),
  ])

  // ── 4. Mint peer tokens ────────────────────────────────────────
  // Each auth mints a NODE token for the remote peer that will connect to it.
  // Token flow: auth-a mints token for node-b (so B can auth when connecting to A)
  log('Step 4/7: Minting peer tokens...')

  const mintPeerToken = async (
    authUrl: string,
    systemToken: string,
    peerNodeId: string,
    label: string
  ): Promise<string> => {
    const result = await mintTokenHandler({
      subject: peerNodeId,
      principal: 'CATALYST::NODE',
      name: peerNodeId,
      type: 'service',
      trustedDomains: [DOMAIN],
      expiresIn: '24h',
      authUrl,
      token: systemToken,
    })
    if (!result.success) fail(`Failed to mint peer token (${label}): ${result.error}`)
    log(`  ${label}: minted`)
    return result.data.token
  }

  // A <-> B: each auth mints a token for the other's peer
  const [peerTokenAForB, peerTokenBForA] = await Promise.all([
    mintPeerToken(NODES.a.authUrl, systemTokenA, NODES.b.id, 'auth-a -> node-b'),
    mintPeerToken(NODES.b.authUrl, systemTokenB, NODES.a.id, 'auth-b -> node-a'),
  ])

  // B <-> C: each auth mints a token for the other's peer
  const [peerTokenBForC, peerTokenCForB] = await Promise.all([
    mintPeerToken(NODES.b.authUrl, systemTokenB, NODES.c.id, 'auth-b -> node-c'),
    mintPeerToken(NODES.c.authUrl, systemTokenC, NODES.b.id, 'auth-c -> node-b'),
  ])

  // ── 5. Establish BGP peering ───────────────────────────────────
  log('Step 5/7: Establishing BGP peering (A <-> B, B <-> C)...')

  // B registers A (uses token minted by auth-a for B to authenticate)
  log('  B registers peer A...')
  const bAddsA = await createPeerHandler({
    name: NODES.a.id,
    endpoint: NODES.a.orchInternal,
    domains: [DOMAIN],
    peerToken: peerTokenBForA,
    orchestratorUrl: NODES.b.orchUrl,
    token: systemTokenB,
  })
  if (!bAddsA.success) fail(`B -> A peering failed: ${bAddsA.error}`)

  // A registers B (uses token minted by auth-b for A to authenticate)
  log('  A registers peer B...')
  const aAddsB = await createPeerHandler({
    name: NODES.b.id,
    endpoint: NODES.b.orchInternal,
    domains: [DOMAIN],
    peerToken: peerTokenAForB,
    orchestratorUrl: NODES.a.orchUrl,
    token: systemTokenA,
  })
  if (!aAddsB.success) fail(`A -> B peering failed: ${aAddsB.error}`)

  // C registers B (uses token minted by auth-b for C to authenticate)
  log('  C registers peer B...')
  const cAddsB = await createPeerHandler({
    name: NODES.b.id,
    endpoint: NODES.b.orchInternal,
    domains: [DOMAIN],
    peerToken: peerTokenCForB,
    orchestratorUrl: NODES.c.orchUrl,
    token: systemTokenC,
  })
  if (!cAddsB.success) fail(`C -> B peering failed: ${cAddsB.error}`)

  // B registers C (uses token minted by auth-c for B to authenticate)
  log('  B registers peer C...')
  const bAddsC = await createPeerHandler({
    name: NODES.c.id,
    endpoint: NODES.c.orchInternal,
    domains: [DOMAIN],
    peerToken: peerTokenBForC,
    orchestratorUrl: NODES.b.orchUrl,
    token: systemTokenB,
  })
  if (!bAddsC.success) fail(`B -> C peering failed: ${bAddsC.error}`)

  // Wait for BGP handshakes
  log('  Waiting for peering handshakes...')
  await Bun.sleep(1000)
  await Promise.all([
    waitForPeerConnected(NODES.a.orchUrl, systemTokenA, NODES.b.id),
    waitForPeerConnected(NODES.b.orchUrl, systemTokenB, NODES.a.id),
    waitForPeerConnected(NODES.b.orchUrl, systemTokenB, NODES.c.id),
    waitForPeerConnected(NODES.c.orchUrl, systemTokenC, NODES.b.id),
  ])
  log('  BGP peering established: A <-> B <-> C')

  // ── 6. Create Zenoh route on Node A ────────────────────────────
  log('Step 6/7: Creating Zenoh TCP route on Node A...')
  const routeResult = await createRouteHandler({
    name: ZENOH_ROUTE.name,
    endpoint: ZENOH_ROUTE.endpoint,
    protocol: ZENOH_ROUTE.protocol,
    orchestratorUrl: NODES.a.orchUrl,
    token: systemTokenA,
  })
  if (!routeResult.success) fail(`Failed to create route: ${routeResult.error}`)
  log(`  Route created: ${ZENOH_ROUTE.name} (${ZENOH_ROUTE.protocol}) -> ${ZENOH_ROUTE.endpoint}`)

  // ── 7. Wait for xDS propagation ───────────────────────────────
  log('Step 7/7: Waiting for Envoy xDS propagation across all nodes...')

  // Node A: ingress listener for zenoh-router
  await waitForListener(NODES.a.envoyAdmin, 'ingress_zenoh-router', 'Envoy A')

  // Node B: egress listener via node-a
  await waitForListener(NODES.b.envoyAdmin, `egress_zenoh-router_via_${NODES.a.id}`, 'Envoy B')

  // Node C: egress listener via node-b
  await waitForListener(NODES.c.envoyAdmin, `egress_zenoh-router_via_${NODES.b.id}`, 'Envoy C')

  // ── Done ──────────────────────────────────────────────────────
  console.log()
  console.log('='.repeat(60))
  console.log('  Initialization Complete')
  console.log('='.repeat(60))
  console.log()
  console.log('  Topology:')
  console.log()
  console.log('    tak-adapter-publisher (emulators: wiesbaden, virginia)')
  console.log('           |')
  console.log('      zenoh-router (:7447)')
  console.log('           |')
  console.log('    [ Node A ] auth-a + orch-a + envoy-proxy-a')
  console.log('           |')
  console.log('    [ Node B ] auth-b + orch-b + envoy-proxy-b  (transit)')
  console.log('           |')
  console.log('    [ Node C ] auth-c + orch-c + envoy-proxy-c')
  console.log('           |')
  console.log('    tak-adapter-consumer (subscribes via TCP passthrough)')
  console.log()
  console.log('  Token flow:')
  console.log('    auth-{a,b,c} -> system admin tokens (bootstrap)')
  console.log('    auth-a minted NODE token for node-b (peer auth)')
  console.log('    auth-b minted NODE tokens for node-a and node-c')
  console.log('    auth-c minted NODE token for node-b')
  console.log()
  console.log('  Traffic path: consumer zenohd -> C -> B -> A -> zenoh-router (:7447)')
  console.log()
  console.log('  Verify:')
  console.log(`    curl -s ${NODES.a.envoyAdmin}/listeners?format=json | jq .`)
  console.log(`    docker compose -f ${COMPOSE_FILE} logs tak-adapter-publisher --follow`)
  console.log(`    docker compose -f ${COMPOSE_FILE} logs tak-adapter-consumer --follow`)
  console.log()

  process.exit(0)
}

main().catch((err) => {
  console.error('\nUnexpected error during initialization:', err)
  process.exit(1)
})
