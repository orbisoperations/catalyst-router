import { Hono } from 'hono';
import { createYoga, createSchema } from 'graphql-yoga';

const schema = createSchema({
    typeDefs: `
    type Book {
      id: ID!
      title: String!
      author: String!
    }

    type Query {
      books: [Book!]!
    }
  `,
    resolvers: {
        Query: {
            books: () => [
                { id: '1', title: 'The Lord of the Rings', author: 'J.R.R. Tolkien' },
                { id: '2', title: 'Pride and Prejudice', author: 'Jane Austen' },
                { id: '3', title: 'The Hobbit', author: 'J.R.R. Tolkien' },
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
console.log(`Books service starting on port ${port}...`);

export default {
    fetch: app.fetch,
    port,
};
