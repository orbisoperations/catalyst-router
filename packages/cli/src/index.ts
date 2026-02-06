import { Command } from 'commander'
import { nodeCommands } from './commands/node/index.js'
import { authCommands } from './commands/auth/index.js'
import { graphqlCommands } from './commands/graphql/index.js'

const program = new Command()

program
  .name('catalyst')
  .description('Catalyst Node CLI - Hierarchical command structure')
  .version(process.env.VERSION || '0.0.0-dev')
  .option(
    '--orchestrator-url <url>',
    'Orchestrator RPC URL',
    process.env.CATALYST_ORCHESTRATOR_URL || 'ws://localhost:3000/rpc'
  )
  .option(
    '--auth-url <url>',
    'Auth service RPC URL',
    process.env.CATALYST_AUTH_URL || 'ws://localhost:4000/rpc'
  )
  .option('--token <token>', 'Auth token', process.env.CATALYST_AUTH_TOKEN)
  .option('--log-level <level>', 'Log level', 'info')

program.addCommand(nodeCommands())
program.addCommand(authCommands())
program.addCommand(graphqlCommands())

program.parse(process.argv)
