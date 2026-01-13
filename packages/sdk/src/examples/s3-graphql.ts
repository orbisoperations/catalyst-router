import { createSchema, createYoga } from 'graphql-yoga';
import { createServer } from 'node:http';
import { Storage } from '../storage';

export function createS3GraphqlServer(storage: Storage) {
    const typeDefs = /* GraphQL */ `
    type Data {
      message: String
      timestamp: String
    }
    type Query {
      s3Data: Data
    }
  `;

    const resolvers = {
        Query: {
            s3Data: async () => {
                const data = await storage.get('data.json');
                if (!data) return null;
                try {
                    const jsonParams = JSON.parse(new TextDecoder().decode(data));
                    return jsonParams;
                } catch (e) {
                    console.error("Failed to parse json", e)
                    return null
                }
            },
        },
    };

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
