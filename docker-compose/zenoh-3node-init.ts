#!/usr/bin/env tsx
/**
 * zenoh-3node-init.ts — Post-startup initialization for the Zenoh 3-node demo.
 *
 * Run this after `docker compose -f zenoh-3node.compose.yaml up -d` to:
 *   1. Wait for all three orchestrators to be healthy
 *   2. Extract the system token from the auth service logs
 *   3. Establish BGP peering: A <-> B, B <-> C
 *   4. Create the Zenoh TCP route on Node A
 *   5. Wait for xDS propagation (Envoy listeners ready on all nodes)
 *   6. Print a status summary
 *
 * Usage:
 *   cd docker-compose
 *   tsx zenoh-3node-init.ts
 */

import { execSync } from 'node:child_process'
import { newWebSocketRpcSession } from 'capnweb'
import type { PublicApi, NetworkClient } from '../apps/orchestrator/src/orchestrator.js'

// ---------------------------------------------------------------------------
// Configuration — must match zenoh-3node.compose.yaml service names and ports
// ---------------------------------------------------------------------------

const DOMAIN = 'somebiz.local.io'

const NODES = {
  a: {
    id: `node-a.${DOMAIN}`,
    orchEndpoint: 'ws://localhost:3001/rpc',
    orchInternal: 'ws://orch-a:3000/rpc',
    envoyAdmin: 'http://localhost:9901',
  },
  b: {
    id: `node-b.${DOMAIN}`,
    orchEndpoint: 'ws://localhost:3002/rpc',
    orchInternal: 'ws://orch-b:3000/rpc',
    envoyAdmin: 'http://localhost:9902',
  },
  c: {
    id: `node-c.${DOMAIN}`,
    orchEndpoint: 'ws://localhost:3003/rpc',
    orchInternal: 'ws://orch-c:3000/rpc',
    envoyAdmin: 'http://localhost:9903',
  },
} as const

const COMPOSE_FILE = 'zenoh-3node.compose.yaml'

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
    await new Promise((r) => setTimeout(r, 1000))
  }
  fail(
    `${label} did not become healthy within ${timeoutMs / 1000}s — is the compose stack running?`
  )
}

async function extractSystemToken(): Promise<string> {
  log('Extracting system token from auth service logs...')
  const stdout = execSync(`docker compose -f ${COMPOSE_FILE} logs auth`, {
    encoding: 'utf-8',
  })

  const match = stdout.match(/System Admin Token minted:\s*(\S+)/)
  if (!match) {
    fail(
      'Could not find system token in auth logs.\n' +
        'Make sure the auth service has started and printed its token.\n' +
        `Try: docker compose -f ${COMPOSE_FILE} logs auth | grep "System Admin Token"`
    )
  }
  const token = match[1]
  log(`System token: ${token.substring(0, 20)}...`)
  return token
}

function getClient(endpoint: string) {
  return newWebSocketRpcSession<PublicApi>(endpoint)
}

async function waitForPeerConnected(
  client: ReturnType<typeof getClient>,
  token: string,
  peerName: string,
  timeoutMs = PEER_TIMEOUT
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const netResult = await client.getNetworkClient(token)
    if (!netResult.success) fail(`Auth failed: ${netResult.error}`)
    const peers = await (netResult as { success: true; client: NetworkClient }).client.listPeers()
    const peer = peers.find((p) => p.name === peerName)
    if (peer && peer.connectionStatus === 'connected') return
    await new Promise((r) => setTimeout(r, 500))
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
    await new Promise((r) => setTimeout(r, 500))
  }
  fail(`${label}: timed out waiting for listener '${listenerName}' (${timeoutMs / 1000}s)`)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log()
  console.log('='.repeat(60))
  console.log('  Zenoh 3-Node Demo — Initialization')
  console.log('='.repeat(60))
  console.log()

  // ── 1. Wait for orchestrators to be healthy ─────────────────────
  log('Step 1/5: Waiting for orchestrators to be healthy...')
  await Promise.all([
    waitForHealth('http://localhost:3001/health', 'node-a'),
    waitForHealth('http://localhost:3002/health', 'node-b'),
    waitForHealth('http://localhost:3003/health', 'node-c'),
  ])

  // ── 2. Extract system token ─────────────────────────────────────
  log('Step 2/5: Getting system token...')
  const token = await extractSystemToken()

  // ── 3. Establish BGP peering ────────────────────────────────────
  log('Step 3/5: Establishing BGP peering (A <-> B, B <-> C)...')
  const clientA = getClient(NODES.a.orchEndpoint)
  const clientB = getClient(NODES.b.orchEndpoint)
  const clientC = getClient(NODES.c.orchEndpoint)

  const netAResult = await clientA.getNetworkClient(token)
  const netBResult = await clientB.getNetworkClient(token)
  const netCResult = await clientC.getNetworkClient(token)
  if (!netAResult.success) fail(`Auth failed on node-a: ${netAResult.error}`)
  if (!netBResult.success) fail(`Auth failed on node-b: ${netBResult.error}`)
  if (!netCResult.success) fail(`Auth failed on node-c: ${netCResult.error}`)

  const netA = (netAResult as { success: true; client: NetworkClient }).client
  const netB = (netBResult as { success: true; client: NetworkClient }).client
  const netC = (netCResult as { success: true; client: NetworkClient }).client

  // Peer A <-> B (both sides must register the other)
  log('  Adding peer: B registers A...')
  await netB.addPeer({
    name: NODES.a.id,
    endpoint: NODES.a.orchInternal,
    domains: [DOMAIN],
  })
  log('  Adding peer: A registers B...')
  await netA.addPeer({
    name: NODES.b.id,
    endpoint: NODES.b.orchInternal,
    domains: [DOMAIN],
  })

  // Peer B <-> C (both sides must register the other)
  log('  Adding peer: C registers B...')
  await netC.addPeer({
    name: NODES.b.id,
    endpoint: NODES.b.orchInternal,
    domains: [DOMAIN],
  })
  log('  Adding peer: B registers C...')
  await netB.addPeer({
    name: NODES.c.id,
    endpoint: NODES.c.orchInternal,
    domains: [DOMAIN],
  })

  // Wait for BGP handshakes
  log('  Waiting for peering handshakes...')
  await new Promise((r) => setTimeout(r, 1000))
  await Promise.all([
    waitForPeerConnected(clientA, token, NODES.b.id),
    waitForPeerConnected(clientB, token, NODES.a.id),
    waitForPeerConnected(clientB, token, NODES.c.id),
    waitForPeerConnected(clientC, token, NODES.b.id),
  ])
  log('  BGP peering established: A <-> B <-> C')

  // ── 4. Create Zenoh route on Node A ─────────────────────────────
  log('Step 4/5: Creating Zenoh TCP route on Node A...')
  const dataAResult = await clientA.getDataChannelClient(token)
  if (!dataAResult.success) fail(`Failed to get data client A: ${dataAResult.error}`)

  const routeResult = await dataAResult.client.addRoute(ZENOH_ROUTE)
  if (!routeResult.success) {
    fail(`Failed to create route: ${(routeResult as { error: string }).error}`)
  }
  log(`  Route created: ${ZENOH_ROUTE.name} (${ZENOH_ROUTE.protocol}) -> ${ZENOH_ROUTE.endpoint}`)

  // ── 5. Wait for xDS propagation ─────────────────────────────────
  log('Step 5/5: Waiting for Envoy xDS propagation across all nodes...')

  // Node A: ingress listener for zenoh-router
  await waitForListener(NODES.a.envoyAdmin, 'ingress_zenoh-router', 'Envoy A')

  // Node B: egress listener via node-a
  await waitForListener(NODES.b.envoyAdmin, `egress_zenoh-router_via_${NODES.a.id}`, 'Envoy B')

  // Node C: egress listener via node-b
  await waitForListener(NODES.c.envoyAdmin, `egress_zenoh-router_via_${NODES.b.id}`, 'Envoy C')

  // ── Done ────────────────────────────────────────────────────────
  console.log()
  console.log('='.repeat(60))
  console.log('  Initialization Complete')
  console.log('='.repeat(60))
  console.log()
  console.log('  Topology:')
  console.log()
  console.log('    radar-publisher')
  console.log('           |')
  console.log('      zenoh-router (:7447)')
  console.log('           |')
  console.log('    [ Node A ] orch-a + envoy-proxy-a')
  console.log('           |')
  console.log('    [ Node B ] orch-b + envoy-proxy-b  (transit)')
  console.log('           |')
  console.log('    [ Node C ] orch-c + envoy-proxy-c')
  console.log('           |')
  console.log('    tak-adapter')
  console.log()
  console.log('  Traffic path: C -> B -> A -> zenoh-router (:7447)')
  console.log()
  console.log('  Verify:')
  console.log(`    curl -s ${NODES.a.envoyAdmin}/listeners?format=json | jq .`)
  console.log(`    docker compose -f ${COMPOSE_FILE} logs tak-adapter --follow`)
  console.log()

  process.exit(0)
}

main().catch((err) => {
  console.error('\nUnexpected error during initialization:', err)
  process.exit(1)
})
