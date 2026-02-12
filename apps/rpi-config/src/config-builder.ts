import type { ResolvedOptions, RpiImageGenConfig } from './types.js'

export function buildConfig(opts: ResolvedOptions): RpiImageGenConfig {
  const config: RpiImageGenConfig = {
    include: { file: 'bookworm-minbase.yaml' },

    device: {
      layer: opts.device,
      hostname: opts.hostname,
      user1: opts.username,
      user1pass: opts.password,
    },

    image: {
      layer: 'image-rpios',
      boot_part_size: opts.bootPartSize,
      root_part_size: opts.rootPartSize,
      name: opts.imageName,
    },

    layer: {},
  }

  // --- Always-on layers (mode-dependent) ---
  if (opts.mode === 'native') {
    config.layer.otel = 'catalyst-otel'
    config.layer.app = 'catalyst-node'

    config.otel = {
      version: opts.otelVersion,
    }
  } else {
    config.docker = { trust_user1: 'y' }
    config.layer.container = 'docker-debian-bookworm'
    config.layer.app = 'catalyst-docker-stack'
  }

  // --- WiFi (optional) ---
  if (opts.wifiSsid) {
    config.layer.wifi = 'catalyst-wifi'
    config.wifi = {
      ssid: opts.wifiSsid,
      password: opts.wifiPassword ?? '',
      country: opts.wifiCountry,
    }
  }

  // --- SSH ---
  if (opts.sshPubkey && opts.sshPubkey !== false) {
    config.ssh = {
      pubkey_only: 'y',
      pubkey_user1: opts.sshPubkey as string,
    }
  }

  // --- Cloudflared (optional) ---
  if (opts.cloudflaredToken) {
    config.layer.tunnel = 'catalyst-cloudflared'
    config.cloudflared = {
      tunnel_token: opts.cloudflaredToken,
    }
  }

  // --- Console autologin + journal stream (optional) ---
  if (opts.autologin !== false) {
    config.layer.console = 'catalyst-console'
  }

  // --- Catalyst node config ---
  config.catalyst = {
    ...(opts.mode === 'docker' && opts.registry
      ? { registry: opts.registry, tag: opts.tag ?? 'latest' }
      : {}),
    node_id: opts.nodeId ?? '',
    peering_secret: opts.peeringSecret ?? '',
    domains: opts.domains ?? '',
    port: String(opts.port),
    bootstrap_token: opts.bootstrapToken ?? '',
    log_level: opts.logLevel,
  }

  return config
}
