import { Hono } from 'hono'
import { createYoga } from 'graphql-yoga'
import { makeExecutableSchema } from '@graphql-tools/schema'
import { stitchingDirectives } from '@graphql-tools/stitching-directives'

const { allStitchingDirectivesTypeDefs, stitchingDirectivesValidator } = stitchingDirectives()

const typeDefs = `
    ${allStitchingDirectivesTypeDefs}
    
    type Book {
      id: ID!
      title: String!
      author: String!
    }

    type Query {
      books: [Book!]!
      _sdl: String!
    }
`

const resolvers = {
  Query: {
    books: () => [
      { id: '1', title: 'The Lord of the Rings', author: 'J.R.R. Tolkien' },
      { id: '2', title: 'Pride and Prejudice', author: 'Jane Austen' },
      { id: '3', title: 'The Hobbit', author: 'J.R.R. Tolkien' },
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

app.all('/graphql', (c) =>
  (yoga.fetch as unknown as (req: Request, env: unknown) => Promise<Response>)(c.req.raw, c.env)
)

app.get('/health', (c) => c.json({ status: 'ok' }))

const port = Number(process.env.PORT) || 8080
console.log(`Books service starting on port ${port}...`)
console.log('BOOKS_STARTED')

export default {
  fetch: app.fetch,
  port,
}
