import { Command, Option } from 'commander'
import { loadConfigFile, applyConfigFileValues } from './config-file.js'
import { startCompositeServer } from './server.js'

const program = new Command()

program
  .name('catalyst-node')
  .description('Catalyst composite node — all services in a single binary')
  .version('1.0.0')
  .addOption(new Option('--config <path>', 'Path to JSON config file').env('CATALYST_NODE_CONFIG'))
  .addOption(
    new Option('--node-id <id>', 'Node identifier (must match *.somebiz.local.io)').env(
      'CATALYST_NODE_ID'
    )
  )
  .addOption(
    new Option(
      '--peering-endpoint <url>',
      'WebSocket endpoint for peering (auto-derived from port in composite mode)'
    ).env('CATALYST_PEERING_ENDPOINT')
  )
  .addOption(new Option('--port <port>', 'Port to listen on').env('PORT').default('3000'))
  .addOption(new Option('--hostname <host>', 'Hostname to bind to').default('0.0.0.0'))
  .addOption(
    new Option('--domains <domains>', 'Comma-separated list of trusted domains').env(
      'CATALYST_DOMAINS'
    )
  )
  .addOption(
    new Option('--peering-secret <secret>', 'iBGP peering secret')
      .env('CATALYST_PEERING_SECRET')
      .default('valid-secret')
  )
  .addOption(
    new Option('--keys-db <path>', 'SQLite database path for auth keys')
      .env('CATALYST_AUTH_KEYS_DB')
      .default('keys.db')
  )
  .addOption(
    new Option('--tokens-db <path>', 'SQLite database path for auth tokens')
      .env('CATALYST_AUTH_TOKENS_DB')
      .default('tokens.db')
  )
  .addOption(new Option('--revocation', 'Enable token revocation').default(true))
  .addOption(new Option('--no-revocation', 'Disable token revocation'))
  .addOption(
    new Option('--revocation-max-size <n>', 'Max revocation list size').env(
      'CATALYST_AUTH_REVOCATION_MAX_SIZE'
    )
  )
  .addOption(
    new Option('--bootstrap-token <token>', 'Bootstrap authentication token').env(
      'CATALYST_BOOTSTRAP_TOKEN'
    )
  )
  .addOption(
    new Option('--bootstrap-ttl <ms>', 'Bootstrap token TTL in milliseconds').env(
      'CATALYST_BOOTSTRAP_TTL'
    )
  )
  .addOption(
    new Option(
      '--gateway-endpoint <url>',
      'Override gateway RPC endpoint for route sync (auto-configured in composite mode)'
    ).env('CATALYST_GQL_GATEWAY_ENDPOINT')
  )
  .addOption(new Option('--log-level <level>', 'Log level').default('info'))

program.hook('preAction', async (thisCommand) => {
  // Handle --revocation env var manually. Commander's .env() on boolean
  // flags triggers on any defined value, but we need === 'true' semantics.
  const revEnv = process.env.CATALYST_AUTH_REVOCATION
  if (revEnv !== undefined) {
    const source = thisCommand.getOptionValueSource('revocation')
    if (source === 'default') {
      thisCommand.setOptionValueWithSource('revocation', revEnv === 'true', 'env')
    }
  }

  // Load config file if --config was provided
  const configPath = thisCommand.getOptionValue('config') as string | undefined
  if (configPath) {
    const configValues = await loadConfigFile(configPath)
    applyConfigFileValues(thisCommand, configValues)
  }

  // Validate required options after config file has been applied
  // (Commander's makeOptionMandatory runs during parse(), before preAction)
  if (!thisCommand.getOptionValue('nodeId')) {
    thisCommand.error("required option '--node-id <id>' not specified")
  }
})

program.action(async (opts) => {
  try {
    await startCompositeServer(opts)
  } catch (err) {
    console.error('Failed to start composite node:', err)
    process.exit(1)
  }
})

program.parse()
