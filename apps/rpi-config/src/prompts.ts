import { select, input, confirm, password } from '@inquirer/prompts'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { DEFAULTS, DEVICES } from './defaults.js'
import type { ResolvedOptions } from './types.js'

function section(title: string): void {
  console.log(`\n\u2500\u2500\u2500 ${title} ${'\u2500'.repeat(Math.max(0, 50 - title.length))}`)
}

export async function promptMissing(opts: Record<string, unknown>): Promise<ResolvedOptions> {
  const resolved = { ...opts } as ResolvedOptions

  console.log('\n  Catalyst Node \u2014 RPi Image Config Builder\n')

  // --- Deployment Mode ---
  section('Deployment Mode')
  if (!resolved.mode || resolved.mode === DEFAULTS.mode) {
    resolved.mode = await select({
      message: 'How should Catalyst Node be deployed?',
      choices: [
        { name: 'Native binary (recommended \u2014 lower RAM, faster boot)', value: 'native' as const },
        { name: 'Docker Compose (multi-container, service isolation)', value: 'docker' as const },
      ],
    })
  }

  // --- Device ---
  section('Target Device')
  if (!resolved.device || resolved.device === DEFAULTS.device) {
    resolved.device = await select({
      message: 'Which Raspberry Pi model?',
      choices: DEVICES.map((d) => ({ name: d.label, value: d.layer })),
      default: DEFAULTS.device,
    })
  }

  if (!resolved.hostname || resolved.hostname === DEFAULTS.hostname) {
    resolved.hostname = await input({
      message: 'System hostname:',
      default: DEFAULTS.hostname,
    })
  }

  // --- User Account ---
  section('User Account')
  if (!resolved.username || resolved.username === DEFAULTS.username) {
    resolved.username = await input({
      message: 'Username:',
      default: DEFAULTS.username,
    })
  }

  if (!resolved.password) {
    resolved.password = await password({
      message: 'Password:',
      mask: '*',
    })
  }

  // --- WiFi ---
  section('WiFi')
  if (resolved.wifi !== false && !resolved.wifiSsid) {
    const wantWifi = await confirm({ message: 'Configure WiFi?', default: true })
    if (wantWifi) {
      resolved.wifiSsid = await input({ message: 'WiFi SSID:' })
      resolved.wifiPassword = await password({ message: 'WiFi password:', mask: '*' })
      if (!resolved.wifiCountry || resolved.wifiCountry === DEFAULTS.wifiCountry) {
        resolved.wifiCountry = await input({
          message: 'WiFi country code:',
          default: DEFAULTS.wifiCountry,
        })
      }
    }
  }

  // --- SSH ---
  section('SSH')
  if (resolved.sshPubkey !== false && !resolved.sshPubkey) {
    const keyFiles = [
      join(homedir(), '.ssh', 'id_ed25519.pub'),
      join(homedir(), '.ssh', 'id_rsa.pub'),
    ]
    for (const keyFile of keyFiles) {
      if (existsSync(keyFile)) {
        const useIt = await confirm({ message: `Found ${keyFile} \u2014 use this key?` })
        if (useIt) {
          resolved.sshPubkey = readFileSync(keyFile, 'utf-8').trim()
          break
        }
      }
    }
    if (!resolved.sshPubkey) {
      resolved.sshPubkey = await input({ message: 'SSH public key (or leave empty):' })
    }
  }

  // --- Docker registry (docker mode only) ---
  if (resolved.mode === 'docker') {
    section('Docker Registry')
    if (!resolved.registry) {
      resolved.registry = await input({ message: 'Container registry (e.g. ghcr.io/your-org):' })
    }
    if (!resolved.tag || resolved.tag === DEFAULTS.tag) {
      resolved.tag = await input({ message: 'Image tag:', default: DEFAULTS.tag })
    }
  }

  // --- Catalyst Node ---
  section('Catalyst Node')
  if (!resolved.nodeId) {
    resolved.nodeId = await input({
      message: 'Node ID (leave empty for auto-generate):',
    })
  }

  if (!resolved.peeringSecret) {
    resolved.peeringSecret = await password({
      message: 'Peering secret:',
      mask: '*',
    })
  }

  if (!resolved.domains) {
    resolved.domains = await input({
      message: 'Trusted domains (comma-separated, or empty):',
    })
  }

  // --- Cloudflared ---
  section('Remote Access')
  if (resolved.cloudflared !== false && !resolved.cloudflaredToken) {
    const wantTunnel = await confirm({
      message: 'Enable Cloudflare Tunnel for remote SSH?',
      default: false,
    })
    if (wantTunnel) {
      resolved.cloudflaredToken = await input({ message: 'Cloudflare Tunnel token:' })
    }
  }

  // --- Output ---
  section('Output')
  if (!resolved.output || resolved.output === DEFAULTS.output) {
    resolved.output = await input({
      message: 'Output file path:',
      default: DEFAULTS.output,
    })
  }

  return resolved
}
