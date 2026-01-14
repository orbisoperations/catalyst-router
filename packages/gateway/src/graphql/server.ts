import { Hono } from 'hono';
import { createYoga, createSchema, YogaInitialContext } from 'graphql-yoga';
import { stitchSchemas } from '@graphql-tools/stitch';

import { AsyncExecutor, Executor } from '@graphql-tools/utils';
import { buildSchema, parse, print, GraphQLError, getIntrospectionQuery, buildClientSchema } from 'graphql';
import { GatewayConfig } from '../rpc/server.js';
import { createAuthMiddleware, clearJwksCache } from '../middleware/auth.js';

export class GatewayGraphqlServer {
    private yoga: ReturnType<typeof createYoga> | null = null;
    private authConfig: GatewayConfig['auth'] = undefined;

    constructor() {
        // Initialize with a default health check schema
        this.createYogaInstance([
            {
                typeDefs: 'type Query { status: String }',
                resolvers: { Query: { status: () => 'Waiting for configuration...' } },
            },
        ]);
    }

    async reload(config: GatewayConfig): Promise<{ success: true } | { success: false; error: string }> {
        console.log('Reloading gateway with new config...', config);

        // Update auth config (clear cache if auth settings changed)
        if (config.auth?.jwksUrl !== this.authConfig?.jwksUrl) {
            clearJwksCache();
        }
        this.authConfig = config.auth;

        try {
            const subschemas = await Promise.all(
                config.services.map(async (service) => {
                    // Check if the service exposes an SDL
                    await this.validateServiceSdl(service.url, service.token);

                    const executor = this.createRemoteExecutor(service.url, service.token);
                    const schema = await this.fetchRemoteSchema(executor);
                    return {
                        schema,
                        executor,
                    };
                })
            );

            if (subschemas.length === 0) {
                console.warn('No services configured, reverting to default status schema.');
                this.createYogaInstance([
                    {
                        typeDefs: 'type Query { status: String }',
                        resolvers: { Query: { status: () => 'No services configured.' } },
                    },
                ]);
                return { success: true };
            }

            const stitchedSchema = stitchSchemas({
                subschemas,
            });

            this.createYogaInstance({ schema: stitchedSchema });
            console.log('Gateway reloaded successfully.');
            return { success: true };
        } catch (error: any) {
            console.error('Failed to reload gateway:', error);
            // We do NOT update the yoga instance here, effectively keeping the last known good config.
            return { success: false, error: error.message };
        }
    }

    fetch(request: Request, env: any, ctx: any) {
        if (!this.yoga) {
            return new Response('Gateway not initialized', { status: 503 });
        }
        return this.yoga.fetch(request, env, ctx);
    }

    getAuthConfig(): GatewayConfig['auth'] {
        return this.authConfig;
    }

    private createYogaInstance(schemaOrConfig: any) {
        let schema;
        if (schemaOrConfig.schema) {
            schema = schemaOrConfig.schema;
        } else if (Array.isArray(schemaOrConfig)) {
            schema = createSchema({
                typeDefs: schemaOrConfig.map(c => c.typeDefs),
                resolvers: schemaOrConfig.map(c => c.resolvers)
            });
        } else {
            schema = schemaOrConfig;
        }

        this.yoga = createYoga({
            schema,
            graphqlEndpoint: '/graphql',
            landingPage: false,
        });
    }

    private createRemoteExecutor(url: string, token?: string): AsyncExecutor {
        return async ({ document, variables, operationName, extensions }) => {
            const query = print(document);
            const fetchResult = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                    ...(token ? { Authorization: `Bearer ${token}` } : {}),
                },
                body: JSON.stringify({ query, variables, operationName, extensions }),
            });
            return fetchResult.json();
        };
    }

    private async fetchRemoteSchema(executor: Executor) {
        const result: any = await executor({ document: parse(getIntrospectionQuery()) });
        if (result.errors) {
            throw new Error(result.errors.map((e: any) => e.message).join('\n'));
        }
        return buildClientSchema(result.data);
    }

    private async validateServiceSdl(url: string, token?: string) {
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                    ...(token ? { Authorization: `Bearer ${token}` } : {}),
                },
                body: JSON.stringify({ query: 'query { _sdl }' })
            });

            if (!res.ok) {
                throw new Error(`Service returned status ${res.status}`);
            }

            const result = await res.json() as any;
            if (result.errors) {
                throw new Error(result.errors.map((e: any) => e.message).join(', '));
            }

            const sdl = result.data?._sdl;
            if (!sdl || typeof sdl !== 'string' || sdl.trim().length === 0) {
                throw new Error('Service returned empty or invalid SDL');
            }
        } catch (error: any) {
            throw new Error(`Service validation failed for ${url}: ${error.message}`);
        }
    }
}

export function createGatewayHandler(gateway?: GatewayGraphqlServer): { app: Hono; server: GatewayGraphqlServer } {
    const server = gateway || new GatewayGraphqlServer();
    const app = new Hono();

    // Dynamic auth middleware - checks server's auth config on each request
    app.use('/*', async (c, next) => {
        const authConfig = server.getAuthConfig();
        if (authConfig) {
            const middleware = createAuthMiddleware(authConfig);
            return middleware(c, next);
        }
        return next();
    });

    app.all('/*', (c) => server.fetch(c.req.raw, c.env, {}));
    return { app, server };
}

