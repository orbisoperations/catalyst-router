import { Command } from 'commander'
import chalk from 'chalk'
import {
  ListStreamsInputSchema,
  GetStreamInputSchema,
  SubscribeStreamInputSchema,
  WatchStreamsInputSchema,
} from '../../types.js'
import {
  listStreamsHandler,
  getStreamHandler,
  subscribeStreamHandler,
  watchStreamsHandler,
} from '../../handlers/video-stream-handlers.js'

export function streamCommands(): Command {
  const stream = new Command('stream').description('Manage video streams')

  stream
    .command('list')
    .description('List video streams')
    .option('--scope <scope>', 'Filter by scope (all, local, remote)')
    .option('--source-node <node>', 'Filter by source node')
    .option('--protocol <protocol>', 'Filter by protocol')
    .option('--token <token>', 'Auth token')
    .action(async (options, cmd) => {
      const globals = cmd.optsWithGlobals()
      const validation = ListStreamsInputSchema.safeParse({
        scope: options.scope,
        sourceNode: options.sourceNode,
        protocol: options.protocol,
        token: options.token || globals.token || process.env.CATALYST_AUTH_TOKEN,
        videoUrl: globals.videoUrl,
      })

      if (!validation.success) {
        console.error(chalk.red('Invalid input:'))
        validation.error.issues.forEach((issue) => {
          console.error(chalk.yellow(`- ${issue.path.join('.')}: ${issue.message}`))
        })
        process.exit(1)
      }

      try {
        const result = await listStreamsHandler(validation.data)

        if (result.success) {
          if (result.data.streams.length === 0) {
            console.log(chalk.yellow('No streams found.'))
          } else {
            console.table(
              result.data.streams.map((s) => ({
                Name: s.name,
                Protocol: s.protocol,
                Source: s.source,
                'Source Node': s.sourceNode,
                Endpoint: s.endpoint || 'N/A',
              }))
            )
          }
          process.exit(0)
        } else {
          console.error(chalk.red(`[error] Failed to list streams: ${result.error}`))
          process.exit(1)
        }
      } catch (error) {
        console.error(chalk.red(`[error] Error: ${error instanceof Error ? error.message : error}`))
        process.exit(1)
      }
    })

  stream
    .command('get')
    .description('Get details of a specific stream')
    .argument('<name>', 'Stream name')
    .option('--token <token>', 'Auth token')
    .action(async (name, options, cmd) => {
      const globals = cmd.optsWithGlobals()
      const validation = GetStreamInputSchema.safeParse({
        name,
        token: options.token || globals.token || process.env.CATALYST_AUTH_TOKEN,
        videoUrl: globals.videoUrl,
      })

      if (!validation.success) {
        console.error(chalk.red('Invalid input:'))
        validation.error.issues.forEach((issue) => {
          console.error(chalk.yellow(`- ${issue.path.join('.')}: ${issue.message}`))
        })
        process.exit(1)
      }

      try {
        const result = await getStreamHandler(validation.data)

        if (result.success) {
          const s = result.data.stream
          console.log(`${chalk.cyan('Name:')}        ${s.name}`)
          console.log(`${chalk.cyan('Protocol:')}    ${s.protocol}`)
          console.log(`${chalk.cyan('Endpoint:')}    ${s.endpoint || 'N/A'}`)
          console.log(`${chalk.cyan('Source:')}      ${s.source}`)
          console.log(`${chalk.cyan('Source Node:')} ${s.sourceNode}`)
          if (s.metadata && Object.keys(s.metadata).length > 0) {
            console.log(`${chalk.cyan('Metadata:')}`)
            for (const [key, value] of Object.entries(s.metadata)) {
              console.log(`  ${key}: ${value}`)
            }
          }
          if (s.nodePath && s.nodePath.length > 0) {
            console.log(`${chalk.cyan('Node Path:')}   ${s.nodePath.join(' -> ')}`)
          }
          process.exit(0)
        } else {
          console.error(chalk.red(`[error] ${result.error}`))
          process.exit(1)
        }
      } catch (error) {
        console.error(chalk.red(`[error] Error: ${error instanceof Error ? error.message : error}`))
        process.exit(1)
      }
    })

  stream
    .command('subscribe')
    .description('Subscribe to a video stream and get playback URLs')
    .argument('<name>', 'Stream name')
    .option('--token <token>', 'Auth token')
    .action(async (name, options, cmd) => {
      const globals = cmd.optsWithGlobals()
      const validation = SubscribeStreamInputSchema.safeParse({
        name,
        token: options.token || globals.token || process.env.CATALYST_AUTH_TOKEN,
        videoUrl: globals.videoUrl,
      })

      if (!validation.success) {
        console.error(chalk.red('Invalid input:'))
        validation.error.issues.forEach((issue) => {
          console.error(chalk.yellow(`- ${issue.path.join('.')}: ${issue.message}`))
        })
        process.exit(1)
      }

      try {
        const result = await subscribeStreamHandler(validation.data)

        if (result.success) {
          console.log(chalk.green(`[ok] Subscribed to '${result.data.name}'`))
          console.log(`  ${chalk.cyan('RTSP:')}   ${result.data.playbackEndpoints.rtsp}`)
          console.log(`  ${chalk.cyan('HLS:')}    ${result.data.playbackEndpoints.hls}`)
          console.log(`  ${chalk.cyan('WebRTC:')} ${result.data.playbackEndpoints.webrtc}`)
          console.log(`  ${chalk.cyan('SRT:')}    ${result.data.playbackEndpoints.srt}`)
          process.exit(0)
        } else {
          console.error(chalk.red(`[error] ${result.error}`))
          process.exit(1)
        }
      } catch (error) {
        console.error(chalk.red(`[error] Error: ${error instanceof Error ? error.message : error}`))
        process.exit(1)
      }
    })

  stream
    .command('watch')
    .description('Watch for stream catalog changes')
    .option('--scope <scope>', 'Filter by scope (all, local, remote)')
    .option('--source-node <node>', 'Filter by source node')
    .option('--protocol <protocol>', 'Filter by protocol')
    .option('--token <token>', 'Auth token')
    .option('--interval <ms>', 'Polling interval in milliseconds', '5000')
    .action(async (options, cmd) => {
      const globals = cmd.optsWithGlobals()
      const validation = WatchStreamsInputSchema.safeParse({
        scope: options.scope,
        sourceNode: options.sourceNode,
        protocol: options.protocol,
        token: options.token || globals.token || process.env.CATALYST_AUTH_TOKEN,
        videoUrl: globals.videoUrl,
        interval: parseInt(options.interval, 10),
      })

      if (!validation.success) {
        console.error(chalk.red('Invalid input:'))
        validation.error.issues.forEach((issue) => {
          console.error(chalk.yellow(`- ${issue.path.join('.')}: ${issue.message}`))
        })
        process.exit(1)
      }

      const input = validation.data

      console.log(chalk.cyan(`[watching] Polling every ${input.interval}ms... (Ctrl+C to stop)`))

      // Initial fetch
      const initialResult = await watchStreamsHandler(input)
      if (!initialResult.success) {
        console.error(chalk.red(`[error] ${initialResult.error}`))
        process.exit(1)
      }

      let previousStreams = new Map(initialResult.data.streams.map((s) => [s.name, s]))

      console.log(`--- Initial streams (${previousStreams.size}) ---`)
      for (const s of initialResult.data.streams) {
        console.log(`  ${s.name} (${s.source}, ${s.sourceNode})`)
      }

      const intervalId = setInterval(async () => {
        const result = await watchStreamsHandler(input)
        if (!result.success) {
          clearInterval(intervalId)
          console.error(chalk.red(`[error] ${result.error}`))
          process.exit(1)
        }

        const currentStreams = new Map(result.data.streams.map((s) => [s.name, s]))

        // Detect additions
        for (const [name, stream] of currentStreams) {
          if (!previousStreams.has(name)) {
            console.log(chalk.green(`[+] ${name} (${stream.source}, ${stream.sourceNode})`))
          }
        }

        // Detect removals
        for (const [name] of previousStreams) {
          if (!currentStreams.has(name)) {
            console.log(chalk.red(`[-] ${name}`))
          }
        }

        previousStreams = currentStreams
      }, input.interval)

      // Handle SIGINT for clean exit
      const onSigint = () => {
        clearInterval(intervalId)
        process.exit(0)
      }
      process.on('SIGINT', onSigint)
    })

  return stream
}
