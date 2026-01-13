import { Hono } from 'hono';
import { createYoga, createSchema } from 'graphql-yoga';

const schema = createSchema({
    typeDefs: `
    type Movie {
      id: ID!
      title: String!
      director: String!
    }

    type Query {
      movies: [Movie!]!
    }
  `,
    resolvers: {
        Query: {
            movies: () => [
                { id: '1', title: 'The Lord of the Rings: The Fellowship of the Ring', director: 'Peter Jackson' },
                { id: '2', title: 'Super Mario Bros.', director: 'Rocky Morton, Annabel Jankel' },
                { id: '3', title: 'Pride & Prejudice', director: 'Joe Wright' },
            ],
        },
    },
});

const app = new Hono();
const yoga = createYoga({
    schema,
    graphqlEndpoint: '/graphql',
    landingPage: false,
});

app.all('/graphql', (c) => yoga.fetch(c.req.raw as unknown as Request, c.env));

app.get('/health', (c) => c.text('OK'));

const port = Number(process.env.PORT) || 8080;
console.log(`Movies service starting on port ${port}...`);

export default {
    fetch: app.fetch,
    port,
};
