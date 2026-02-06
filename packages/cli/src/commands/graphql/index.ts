import { Command } from 'commander'
import { ideCommand } from './ide.js'

export function graphqlCommands(): Command {
  const graphql = new Command('graphql').description('GraphQL development tools')

  graphql.addCommand(ideCommand())

  return graphql
}
