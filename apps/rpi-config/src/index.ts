import { Command, Option } from 'commander'
import { promptMissing } from './prompts.js'
import { buildConfig } from './config-builder.js'
import { renderYaml } from './yaml-writer.js'
import { validateLayers, printValidationResults } from './validator.js'
import { writeOutputDir } from './output-writer.js'
import { printInstructions } from './instructions.js'
import { DEFAULTS } from './defaults.js'

const program = new Command()

program
  .name('catalyst-rpi-config')
  .description('Generate rpi-image-gen config YAML for Catalyst Node')
  .version('1.0.0')

  .addOption(new Option('-o, --output-dir <path>', 'Output directory').default(DEFAULTS.outputDir))
  .addOption(
    new Option('-m, --mode <mode>', 'Deployment mode')
      .choices(['native', 'docker'])
      .default(DEFAULTS.mode)
  )
  .addOption(new Option('--dry-run', 'Print YAML to stdout instead of writing files'))

  .addOption(new Option('--device <layer>', 'Device layer').default(DEFAULTS.device))
  .addOption(new Option('--hostname <name>', 'System hostname').default(DEFAULTS.hostname))
  .addOption(new Option('--username <user>', 'Login username').default(DEFAULTS.username))
  .addOption(new Option('--password <pass>', 'Login password'))

  .addOption(new Option('--wifi-ssid <ssid>', 'WiFi SSID'))
  .addOption(new Option('--wifi-password <pass>', 'WiFi password'))
  .addOption(new Option('--wifi-country <code>', 'WiFi country code').default(DEFAULTS.wifiCountry))
  .addOption(new Option('--no-wifi', 'Skip WiFi'))

  .addOption(new Option('--ssh-pubkey <key>', 'SSH public key'))
  .addOption(new Option('--ssh-pubkey-file <path>', 'SSH public key file'))
  .addOption(new Option('--no-ssh-pubkey', 'Skip SSH key'))

  .addOption(new Option('--node-id <id>', 'Node identifier').env('CATALYST_NODE_ID'))
  .addOption(
    new Option('--peering-secret <secret>', 'iBGP peering secret').env('CATALYST_PEERING_SECRET')
  )
  .addOption(new Option('--domains <list>', 'Trusted domains').env('CATALYST_DOMAINS'))
  .addOption(new Option('--port <port>', 'Listen port').default(String(DEFAULTS.port)).env('PORT'))
  .addOption(
    new Option('--bootstrap-token <token>', 'Auth bootstrap token').env('CATALYST_BOOTSTRAP_TOKEN')
  )
  .addOption(
    new Option('--log-level <level>', 'Log level')
      .choices(['debug', 'info', 'warn', 'error'])
      .default(DEFAULTS.logLevel)
  )

  .addOption(new Option('--registry <url>', 'Container registry (docker mode)'))
  .addOption(new Option('--tag <tag>', 'Container image tag').default(DEFAULTS.tag))

  .addOption(
    new Option('--otel-version <ver>', 'OTEL Collector version').default(DEFAULTS.otelVersion)
  )

  .addOption(new Option('--cloudflared-token <token>', 'Cloudflare Tunnel token'))
  .addOption(new Option('--no-cloudflared', 'Skip cloudflared'))

  .addOption(new Option('--image-name <name>', 'Output image name').default(DEFAULTS.imageName))
  .addOption(
    new Option('--boot-part-size <size>', 'Boot partition size').default(DEFAULTS.bootPartSize)
  )
  .addOption(new Option('--root-part-size <size>', 'Root partition size'))

  .addOption(new Option('--non-interactive', 'Skip interactive prompts'))

program.hook('preAction', async (thisCommand) => {
  // Read SSH key from file if --ssh-pubkey-file was provided
  const keyFile = thisCommand.getOptionValue('sshPubkeyFile') as string | undefined
  if (keyFile) {
    const { readFileSync } = await import('node:fs')
    const key = readFileSync(keyFile, 'utf-8').trim()
    thisCommand.setOptionValueWithSource('sshPubkey', key, 'cli')
  }

  // Default root partition size based on mode
  if (!thisCommand.getOptionValue('rootPartSize')) {
    const mode = thisCommand.getOptionValue('mode') as string
    const size = mode === 'docker' ? DEFAULTS.rootPartSizeDocker : DEFAULTS.rootPartSizeNative
    thisCommand.setOptionValueWithSource('rootPartSize', size, 'default')
  }
})

program.action(async (opts) => {
  // 1. Resolve missing options
  const resolved = opts.nonInteractive ? opts : await promptMissing(opts)

  // 2. Build config object
  const config = buildConfig(resolved)

  // 3. Render YAML with inline comments
  const yamlContent = renderYaml(config, resolved)

  // 4. Validate layers (embedded lookup, no filesystem paths needed)
  const results = validateLayers(config)
  printValidationResults(results)
  const failures = results.filter((r: { found: boolean }) => !r.found)
  if (failures.length > 0) {
    process.stderr.write(`\n\u2717 Validation failed: ${failures.length} layer(s) not found.\n`)
    process.stderr.write(
      `  Missing: ${failures.map((f: { name: string }) => f.name).join(', ')}\n\n`
    )
    process.exit(1)
  }

  // 5. Output
  if (resolved.dryRun) {
    // YAML to stdout, instructions to stderr
    process.stdout.write(yamlContent)
    printInstructions(resolved.outputDir, resolved, process.stderr)
  } else {
    writeOutputDir({
      outputDir: resolved.outputDir,
      configYaml: yamlContent,
      config,
      mode: resolved.mode,
    })
    printInstructions(resolved.outputDir, resolved, process.stderr)
  }
})

program.parse()
