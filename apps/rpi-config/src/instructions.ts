import { resolve, dirname } from 'node:path'
import type { Writable } from 'node:stream'
import type { ResolvedOptions } from './types.js'

export function printInstructions(
  configPath: string,
  opts: ResolvedOptions,
  stream: Writable = process.stdout
): void {
  const absConfig = resolve(configPath)
  const srcDir = resolve(dirname(absConfig), '..')
  const rpiImageGen = opts.rpiImageGen || '../rpi-image-gen'

  const prerequisite =
    opts.mode === 'native'
      ? `
  Prerequisites:

    1. Ensure the pre-built binary exists:
       ls ${srcDir}/bin/catalyst-node

       If not, build it from the catalyst-node repo:
       bun build --compile --target=bun-linux-arm64 \\
         --outfile bin/catalyst-node apps/node/src/index.ts
       cp bin/catalyst-node ${srcDir}/bin/catalyst-node
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
\x1b[32m\u2713\x1b[0m Config ${opts.dryRun ? 'generated' : `written to ${absConfig}`}
${prerequisite}
  To build the image:

    cd ${rpiImageGen}
    ./rpi-image-gen build \\
      -S ${srcDir} \\
      -c ${absConfig}

  To flash the image:

    sudo rpi-imager --cli \\
      ./work/image-${opts.imageName}/${opts.imageName}.img \\
      /dev/mmcblk0
`)
}
