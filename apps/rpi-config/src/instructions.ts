import { resolve, join } from 'node:path'
import type { Writable } from 'node:stream'
import type { ResolvedOptions } from './types.js'

export function printInstructions(
  outputDir: string,
  opts: ResolvedOptions,
  stream: Writable = process.stdout
): void {
  const absDir = resolve(outputDir)
  const configPath = join(absDir, 'config.yaml')

  const prerequisite =
    opts.mode === 'native'
      ? `
  Prerequisites:

    1. Compile the catalyst-node binary into the output directory:
       bun build --compile --target=bun-linux-arm64 \\
         --outfile ${absDir}/bin/catalyst-node apps/node/src/index.ts
`
      : `
  Prerequisites:

    1. Publish ARM64 container images:
       docker buildx build --platform linux/amd64,linux/arm64 \\
         -t ${opts.registry}/catalyst-auth:${opts.tag} \\
         -f apps/auth/Dockerfile --push .
       # Repeat for: catalyst-gateway, catalyst-orchestrator
`

  stream.write(`
\x1b[32m\u2713\x1b[0m Config ${opts.dryRun ? 'generated' : `written to ${absDir}/`}
${prerequisite}
  To build the image:

    # Option A — Docker (macOS / any host)
    ./builds/rpi/build-docker.sh --source-dir ${absDir} ${configPath}

    # Option B — Native arm64 Debian host
    ./builds/rpi/build.sh --source-dir ${absDir} ${configPath}

  To flash the image:

    # macOS (requires Raspberry Pi Imager — https://www.raspberrypi.com/software/):
    #   1. Find your SD card device:  diskutil list
    #   2. Flash (replace diskN with your SD card):
    /Applications/Raspberry\\ Pi\\ Imager.app/Contents/MacOS/rpi-imager --cli \\
      ${absDir}/build/image-${opts.imageName}/${opts.imageName}.img \\
      /dev/rdiskN

    # Linux:
    sudo rpi-imager --cli \\
      ${absDir}/build/image-${opts.imageName}/${opts.imageName}.img \\
      /dev/sdX
`)
}
