import { Command } from 'commander'
import { tokenCommands } from './token.js'

export function authCommands(): Command {
  const auth = new Command('auth').description('Authentication and token management')

  auth.addCommand(tokenCommands())

  return auth
}
