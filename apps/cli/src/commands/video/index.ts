import { Command } from 'commander'
import { streamCommands } from './stream.js'
import { healthCommand } from './health.js'
import { relayCommands } from './relay.js'

export function videoCommands(): Command {
  const video = new Command('video').description('Video stream management commands')

  video.addCommand(streamCommands())
  video.addCommand(healthCommand())
  video.addCommand(relayCommands())

  return video
}
