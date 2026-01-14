import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, StartedTestContainer } from 'testcontainers';
import path from 'path';
import { execSync, spawn } from 'child_process';

// Skip rebuild if image exists (set REBUILD_IMAGES=true to force rebuild)
const FORCE_REBUILD = process.env.REBUILD_IMAGES === 'true';

function imageExists(imageName: string): boolean {
    try {
        const output = execSync(`podman images -q ${imageName}`, { encoding: 'utf-8' });
        return output.trim().length > 0;
    } catch {
        return false;
    }
}

function ensureImage(imageName: string, dockerfile: string, buildContext: string): void {
    if (!FORCE_REBUILD && imageExists(imageName)) {
        console.log(`Using existing image: ${imageName}`);
        return;
    }

    console.log(`Building image: ${imageName}...`);
    execSync(`podman build -t ${imageName} -f ${dockerfile} .`, {
        cwd: buildContext,
        stdio: 'inherit',
    });
}

describe('Example GraphQL Servers (vitest + testcontainers)', () => {
    const TIMEOUT = 120000;
    const buildContext = path.resolve(__dirname, '../../..');

    describe('Books Service', () => {
        let startedContainer: StartedTestContainer;

        beforeAll(async () => {
            const imageName = 'books-service:test';
            const dockerfile = 'packages/examples/Dockerfile.books';

            ensureImage(imageName, dockerfile, buildContext);

            console.log('Starting container with testcontainers...');
            startedContainer = await new GenericContainer(imageName)
                .withExposedPorts(8080)
                .start();
            
            console.log(`Container started on port ${startedContainer.getMappedPort(8080)}`);
        }, TIMEOUT);

        afterAll(async () => {
            if (startedContainer) await startedContainer.stop();
        }, TIMEOUT);

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
            const imageName = 'movies-service:test';
            const dockerfile = 'packages/examples/Dockerfile.movies';

            ensureImage(imageName, dockerfile, buildContext);

            console.log('Starting container with testcontainers...');
            startedContainer = await new GenericContainer(imageName)
                .withExposedPorts(8080)
                .start();
            
            console.log(`Container started on port ${startedContainer.getMappedPort(8080)}`);
        }, TIMEOUT);

        afterAll(async () => {
            if (startedContainer) await startedContainer.stop();
        }, TIMEOUT);

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
