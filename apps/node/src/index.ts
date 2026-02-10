import { Command } from 'commander'
import { startCompositeServer } from './server.js'

const program = new Command()

program
  .name('catalyst-node')
  .description('Catalyst composite node — all services in a single binary')
  .version('1.0.0')
  .requiredOption(
    '--node-id <id>',
    'Node identifier (must match *.somebiz.local.io)',
    process.env.CATALYST_NODE_ID
  )
  .requiredOption(
    '--peering-endpoint <url>',
    'WebSocket endpoint for peering (e.g., ws://localhost:3000/orchestrator/rpc)',
    process.env.CATALYST_PEERING_ENDPOINT
  )
  .option('--port <port>', 'Port to listen on', process.env.PORT || '3000')
  .option('--hostname <host>', 'Hostname to bind to', '0.0.0.0')
  .option(
    '--domains <domains>',
    'Comma-separated list of trusted domains',
    process.env.CATALYST_DOMAINS
  )
  .option(
    '--peering-secret <secret>',
    'iBGP peering secret',
    process.env.CATALYST_PEERING_SECRET || 'valid-secret'
  )
  .option(
    '--keys-db <path>',
    'SQLite database path for auth keys',
    process.env.CATALYST_AUTH_KEYS_DB || 'keys.db'
  )
  .option(
    '--tokens-db <path>',
    'SQLite database path for auth tokens',
    process.env.CATALYST_AUTH_TOKENS_DB || 'tokens.db'
  )
  .option(
    '--revocation',
    'Enable token revocation',
    process.env.CATALYST_AUTH_REVOCATION === 'true'
  )
  .option(
    '--revocation-max-size <n>',
    'Max revocation list size',
    process.env.CATALYST_AUTH_REVOCATION_MAX_SIZE
  )
  .option(
    '--bootstrap-token <token>',
    'Bootstrap authentication token',
    process.env.CATALYST_BOOTSTRAP_TOKEN
  )
  .option(
    '--bootstrap-ttl <ms>',
    'Bootstrap token TTL in milliseconds',
    process.env.CATALYST_BOOTSTRAP_TTL
  )
  .option(
    '--gateway-endpoint <url>',
    'Override gateway RPC endpoint for route sync (auto-configured in composite mode)',
    process.env.CATALYST_GQL_GATEWAY_ENDPOINT
  )
  .option('--log-level <level>', 'Log level', 'info')
  .action(async (opts) => {
    try {
      await startCompositeServer(opts)
    } catch (err) {
      console.error('Failed to start composite node:', err)
      process.exit(1)
    }
  })

program.parse()
