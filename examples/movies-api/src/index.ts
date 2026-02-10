import { Hono } from 'hono'
import { createYoga } from 'graphql-yoga'
import { makeExecutableSchema } from '@graphql-tools/schema'
import { stitchingDirectives } from '@graphql-tools/stitching-directives'

const { allStitchingDirectivesTypeDefs, stitchingDirectivesValidator } = stitchingDirectives()

const typeDefs = `
    ${allStitchingDirectivesTypeDefs}
    
    type Movie {
      id: ID!
      title: String!
      director: String!
    }

    type Query {
      movies: [Movie!]!
      _sdl: String!
    }
`

const resolvers = {
  Query: {
    movies: () => [
      {
        id: '1',
        title: 'The Lord of the Rings: The Fellowship of the Ring',
        director: 'Peter Jackson',
      },
      { id: '2', title: 'Super Mario Bros.', director: 'Rocky Morton, Annabel Jankel' },
      { id: '3', title: 'Pride & Prejudice', director: 'Joe Wright' },
    ],
    _sdl: () => typeDefs,
  },
}

const schema = stitchingDirectivesValidator(
  makeExecutableSchema({
    typeDefs,
    resolvers,
  })
)

const app = new Hono()
const yoga = createYoga({
  schema,
  graphqlEndpoint: '/graphql',
  landingPage: false,
})

app.all('/graphql', (c) => yoga.fetch(c.req.raw as unknown as Request, c.env))

app.get('/health', (c) => c.json({ status: 'ok' }))

const port = Number(process.env.PORT) || 8080
console.log(`Movies service starting on port ${port}...`)

export default {
  fetch: app.fetch,
  port,
}
