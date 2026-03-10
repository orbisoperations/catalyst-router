import { spawn } from 'node:child_process'
import { Command } from 'commander'
import chalk from 'chalk'
import {
  ListStreamsInputSchema,
  SubscribeStreamInputSchema,
  PlayStreamInputSchema,
} from '../../types.js'
import {
  listStreamsHandler,
  subscribeStreamHandler,
  playStreamHandler,
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
    .command('play')
    .description('Subscribe to a stream and open it in a video player')
    .argument('<name>', 'Stream name')
    .option('--token <token>', 'Auth token')
    .option('--protocol <protocol>', 'Playback protocol (hls, rtsp, srt)', 'hls')
    .option('--player <player>', 'Video player binary (ffplay, mpv, vlc)')
    .action(async (name, options, cmd) => {
      const globals = cmd.optsWithGlobals()
      const validation = PlayStreamInputSchema.safeParse({
        name,
        token: options.token || globals.token || process.env.CATALYST_AUTH_TOKEN,
        videoUrl: globals.videoUrl,
        protocol: options.protocol,
        player: options.player,
      })

      if (!validation.success) {
        console.error(chalk.red('Invalid input:'))
        validation.error.issues.forEach((issue) => {
          console.error(chalk.yellow(`- ${issue.path.join('.')}: ${issue.message}`))
        })
        process.exit(1)
      }

      try {
        const result = await playStreamHandler(validation.data)

        if (result.success) {
          console.log(
            chalk.green(
              `[ok] Playing '${name}' via ${result.data.protocol} using ${result.data.player}`
            )
          )
          console.log(`  ${chalk.cyan('URL:')} ${result.data.url}`)

          const child = spawn(result.data.player, [result.data.url], {
            stdio: 'inherit',
          })

          child.on('close', (code) => {
            process.exit(code ?? 0)
          })

          child.on('error', (err) => {
            console.error(
              chalk.red(`[error] Failed to launch ${result.data.player}: ${err.message}`)
            )
            process.exit(1)
          })
        } else {
          console.error(chalk.red(`[error] ${result.error}`))
          process.exit(1)
        }
      } catch (error) {
        console.error(chalk.red(`[error] Error: ${error instanceof Error ? error.message : error}`))
        process.exit(1)
      }
    })

  return stream
}
