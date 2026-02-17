export const DEFAULTS = {
  output: './catalyst-node.yaml',
  mode: 'native' as const,
  device: 'rpi5',
  hostname: 'catalyst-node',
  username: 'catalyst',
  wifiCountry: 'US',
  port: 3000,
  logLevel: 'info',
  otelVersion: '0.145.0',
  tag: 'latest',
  imageName: 'catalyst-node-image',
  bootPartSize: '200%',
  rootPartSizeNative: '400%',
  rootPartSizeDocker: '500%',
} as const

export const DEVICES = [
  { layer: 'rpi5', label: 'Raspberry Pi 5' },
  { layer: 'pi4', label: 'Raspberry Pi 4' },
  { layer: 'cm5', label: 'Compute Module 5' },
  { layer: 'cm4', label: 'Compute Module 4' },
  { layer: 'zero2w', label: 'Raspberry Pi Zero 2 W' },
] as const
