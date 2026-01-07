import { createSchema, createYoga } from 'graphql-yoga';
import { createServer } from 'node:http';
import { typeDefs, resolvers } from './schema';

export function createGraphqlServer() {
    const schema = createSchema({
        typeDefs,
        resolvers,
    });

    const yoga = createYoga({
        schema,
    });

    const server = createServer(yoga);

    return { yoga, server };
}
