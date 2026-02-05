import { Command } from 'commander'
import { peerCommands } from './peer.js'

export function nodeCommands(): Command {
  const node = new Command('node').description('Node management commands (peers, routes)')

  node.addCommand(peerCommands())

  return node
}
