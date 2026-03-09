import { Command } from 'commander'
import { nodeCommands } from './commands/node/index.js'
import { authCommands } from './commands/auth/index.js'
import { videoCommands } from './commands/video/index.js'

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
  .option(
    '--video-url <url>',
    'Video service URL',
    process.env.CATALYST_VIDEO_URL || 'http://localhost:8100'
  )

program.addCommand(nodeCommands())
program.addCommand(authCommands())
program.addCommand(videoCommands())

program.parse(process.argv)
