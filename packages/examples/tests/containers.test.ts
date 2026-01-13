import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { GenericContainer, Wait, StartedTestContainer } from 'testcontainers';
import path from 'path';

describe('Example GraphQL Servers', () => {
    // Increase timeout for image build
    const TIMEOUT = 120000;

    describe('Books Service', () => {
        let startedContainer: StartedTestContainer;

        beforeAll(async () => {
            // Build and start the container
            // context is packages/examples
            const buildContext = path.resolve(__dirname, '..');

            const imageName = 'books-service:test';
            const dockerfile = 'Dockerfile.books';

            // Workaround for Bun incompatibility with testcontainers' build strategy.
            // GenericContainer.fromDockerfile() uses 'tar-stream' which fails in Bun with:
            // "TypeError: The 'sourceEnd' argument must be of type number. Received undefined"
            // This is likely due to differences in Buffer/Stream implementation in Bun vs Node.
            // We manually build the image using the docker CLI instead.
            const proc = Bun.spawn(['docker', 'build', '-t', imageName, '-f', dockerfile, '.'], {
                cwd: buildContext,
                stdout: 'ignore',
                stderr: 'inherit',
            });
            await proc.exited;

            const container = await new GenericContainer(imageName)
            startedContainer = await container
                .withExposedPorts(8080)
                .withWaitStrategy(Wait.forHttp('/health', 8080))
                .start();
        }, TIMEOUT);

        afterAll(async () => {
            if (startedContainer) await startedContainer.stop();
        });

        it('should serve books', async () => {
            const port = startedContainer.getMappedPort(8080);
            const host = startedContainer.getHost();
            const url = `http://${host}:${port}/graphql`;

            const query = `
                query {
                    books {
                        title
                        author
                    }
                }
            `;

            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query }),
            });

            const result = await response.json();
            expect(result.data).toBeDefined();
            expect(result.data.books).toBeInstanceOf(Array);
            expect(result.data.books[0]).toHaveProperty('title', 'The Lord of the Rings');
        }, TIMEOUT);
    });

    describe('Movies Service', () => {
        let startedContainer: StartedTestContainer;

        beforeAll(async () => {
            const buildContext = path.resolve(__dirname, '..');

            const imageName = 'movies-service:test';
            const dockerfile = 'Dockerfile.movies';

            const proc = Bun.spawn(['docker', 'build', '-t', imageName, '-f', dockerfile, '.'], {
                cwd: buildContext,
                stdout: 'ignore',
                stderr: 'inherit',
            });
            await proc.exited;

            const container = await new GenericContainer(imageName)
            startedContainer = await container
                .withExposedPorts(8080)
                .withWaitStrategy(Wait.forHttp('/health', 8080))
                .start();
        }, TIMEOUT);

        afterAll(async () => {
            if (startedContainer) await startedContainer.stop();
        });

        it('should serve movies', async () => {
            const port = startedContainer.getMappedPort(8080);
            const host = startedContainer.getHost();
            const url = `http://${host}:${port}/graphql`;

            const query = `
                query {
                    movies {
                        title
                        director
                    }
                }
            `;

            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query }),
            });

            const result = await response.json();
            expect(result.data).toBeDefined();
            expect(result.data.movies).toBeInstanceOf(Array);
            expect(result.data.movies[0]).toHaveProperty('title');
        }, TIMEOUT);
    });
});
