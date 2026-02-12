export interface ResolvedOptions {
  output: string
  mode: 'native' | 'docker'
  dryRun?: boolean
  device: string
  hostname: string
  username: string
  password: string
  wifiSsid?: string
  wifiPassword?: string
  wifiCountry: string
  wifi?: boolean
  sshPubkey?: string | false
  sshPubkeyFile?: string
  nodeId?: string
  peeringSecret?: string
  domains?: string
  port: number
  bootstrapToken?: string
  logLevel: string
  registry?: string
  tag?: string
  otelVersion: string
  cloudflaredToken?: string
  cloudflared?: boolean
  imageName: string
  bootPartSize: string
  rootPartSize: string
  rpiImageGen?: string
  skipValidation?: boolean
  nonInteractive?: boolean
}

export interface RpiImageGenConfig {
  include: { file: string }
  device: Record<string, string>
  image: Record<string, string>
  layer: Record<string, string>
  docker?: Record<string, string>
  ssh?: Record<string, string>
  wifi?: Record<string, string>
  otel?: Record<string, string>
  catalyst?: Record<string, string>
  cloudflared?: Record<string, string>
}
