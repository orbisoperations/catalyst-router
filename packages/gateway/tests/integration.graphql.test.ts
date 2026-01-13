import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { GenericContainer, Wait, StartedTestContainer } from 'testcontainers';
import path from 'path';
import { createGatewayHandler, GatewayGraphqlServer } from '../src/graphql/server.ts';

describe('Gateway Integration', () => {
    const TIMEOUT = 120000;
    let booksContainer: StartedTestContainer;
    let moviesContainer: StartedTestContainer;
    let gatewayServer: GatewayGraphqlServer;
    let gatewayApp: any;

    beforeAll(async () => {
        // 1. Start Books Service
        const examplesDir = path.resolve(__dirname, '../../examples');

        {
            const imageName = 'books-service:test';
            const dockerfile = 'Dockerfile.books';
            // Workaround for Bun tar-stream issue
            const proc = Bun.spawn(['docker', 'build', '-t', imageName, '-f', dockerfile, '.'], {
                cwd: examplesDir,
                stdout: 'ignore',
                stderr: 'inherit',
            });
            await proc.exited;

            const container = await new GenericContainer(imageName)
                .withExposedPorts(8080)
                .withWaitStrategy(Wait.forHttp('/health', 8080));
            booksContainer = await container.start();
        }

        // 2. Start Movies Service
        {
            const imageName = 'movies-service:test';
            const dockerfile = 'Dockerfile.movies';
            // Workaround for Bun tar-stream issue
            const proc = Bun.spawn(['docker', 'build', '-t', imageName, '-f', dockerfile, '.'], {
                cwd: examplesDir,
                stdout: 'ignore',
                stderr: 'inherit',
            });
            await proc.exited;

            const container = await new GenericContainer(imageName)
                .withExposedPorts(8080)
                .withWaitStrategy(Wait.forHttp('/health', 8080));
            moviesContainer = await container.start();
        }

        // 3. Start Gateway (in-process)
        // We use createGatewayHandler to get the app and the server instance
        const result = createGatewayHandler();
        gatewayApp = result.app;
        gatewayServer = result.server;

    }, TIMEOUT);

    afterAll(async () => {
        if (booksContainer) await booksContainer.stop();
        if (moviesContainer) await moviesContainer.stop();
    });

    it('should federate books and movies', async () => {
        const booksPort = booksContainer.getMappedPort(8080);
        const booksHost = booksContainer.getHost();
        const moviesPort = moviesContainer.getMappedPort(8080);
        const moviesHost = moviesContainer.getHost();

        // 4. Configure Gateway with dynamic ports
        const config = {
            services: [
                {
                    name: 'books',
                    url: `http://${booksHost}:${booksPort}/graphql`
                },
                {
                    name: 'movies',
                    url: `http://${moviesHost}:${moviesPort}/graphql`
                }
            ]
        };

        const updateResult = await gatewayServer.reload(config);
        expect(updateResult.success).toBe(true);

        // 5. Query Gateway
        const query = `
            query {
                books {
                    title
                    author
                }
                movies {
                    title
                    director
                }
            }
        `;

        const response = await gatewayApp.request('http://localhost/graphql', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query })
        });

        const result = await response.json();

        expect(result.data).toEqual({
            books: [
                { title: 'The Lord of the Rings', author: 'J.R.R. Tolkien' },
                { title: 'Pride and Prejudice', author: 'Jane Austen' },
                { title: 'The Hobbit', author: 'J.R.R. Tolkien' }
            ],
            movies: [
                { title: 'The Lord of the Rings: The Fellowship of the Ring', director: 'Peter Jackson' },
                { title: 'Super Mario Bros.', director: 'Rocky Morton, Annabel Jankel' },
                { title: 'Pride & Prejudice', director: 'Joe Wright' }
            ]
        });
    }, TIMEOUT);
});
