
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { GenericContainer, Network, Wait, StartedTestContainer, StartedNetwork } from 'testcontainers';
import { GatewayIntegrationPlugin } from '../src/plugins/implementations/gateway.js';
import { PluginContext } from '../src/plugins/types.js';
import { RouteTable } from '../src/state/route-table.js';
import { join, resolve } from 'path';

// Increase timeout for builds
const TIMEOUT = 180_000;

describe('GraphQL Plugin E2E with Containers', () => {
    let network: StartedNetwork;
    let gatewayContainer: StartedTestContainer;
    let booksContainer: StartedTestContainer;
    let moviesContainer: StartedTestContainer;

    let gatewayPort: number;
    let booksUri: string;
    let moviesUri: string;

    beforeAll(async () => {
        network = await new Network().start();

        const repoRoot = resolve(__dirname, '../../..');
        const examplesDir = join(repoRoot, 'packages/examples');
        const gatewayDir = join(repoRoot, 'packages/gateway');

        console.log('Building Docker images...');

        const buildBooks = async () => {
            await Bun.spawn(['docker', 'build', '-t', 'books-service:test', '-f', 'packages/examples/Dockerfile.books', '.'], {
                cwd: repoRoot,
                stdout: 'ignore',
                stderr: 'inherit'
            }).exited;
        };

        const buildMovies = async () => {
            await Bun.spawn(['docker', 'build', '-t', 'movies-service:test', '-f', 'packages/examples/Dockerfile.movies', '.'], {
                cwd: repoRoot,
                stdout: 'ignore',
                stderr: 'inherit'
            }).exited;
        };

        const buildGateway = async () => {
            await Bun.spawn(['docker', 'build', '-t', 'gateway-service:test', '-f', 'packages/gateway/Dockerfile', '.'], {
                cwd: repoRoot,
                stdout: 'ignore',
                stderr: 'inherit'
            }).exited;
        };

        await Promise.all([buildBooks(), buildMovies(), buildGateway()]);
        console.log('Docker images built successfully.');

        console.log('Starting Containers...');

        console.log('Starting books container...');
        booksContainer = await new GenericContainer('books-service:test')
            .withExposedPorts(8080)
            .withNetwork(network)
            .withNetworkAliases('books')
            .withStartupTimeout(180_000)
            .withWaitStrategy(Wait.forLogMessage(/running|listening|starting/i).withStartupTimeout(180_000))
            .start();
        console.log('Books container started.');

        const booksPort = booksContainer.getMappedPort(8080);
        booksUri = 'http://books:8080/graphql';
        console.log(`Books started on port ${booksPort}`);

        console.log('Starting movies container...');
        moviesContainer = await new GenericContainer('movies-service:test')
            .withExposedPorts(8080)
            .withNetwork(network)
            .withNetworkAliases('movies')
            .withStartupTimeout(180_000)
            .withWaitStrategy(Wait.forLogMessage(/running|listening|starting/i).withStartupTimeout(180_000))
            .start();
        console.log('Movies container started.');

        moviesUri = 'http://movies:8080/graphql';

        console.log('Starting gateway container...');
        gatewayContainer = await new GenericContainer('gateway-service:test')
            .withExposedPorts(4000)
            .withNetwork(network)
            .withNetworkAliases('gateway')
            .withStartupTimeout(180_000)
            .withWaitStrategy(Wait.forLogMessage(/running|listening|starting/i).withStartupTimeout(180_000))
            .start();
        console.log('Gateway container started.');

        gatewayPort = gatewayContainer.getMappedPort(4000);
        console.log(`Gateway started on port ${gatewayPort}`);

    }, TIMEOUT);

    afterAll(async () => {
        await moviesContainer?.stop();
        await booksContainer?.stop();
        await gatewayContainer?.stop();
        try {
            await network?.stop();
        } catch (e) {
            console.error('Failed to stop network:', e);
        }
    });

    it('should handle full lifecycle: unconfigured -> add -> update -> delete', async () => {
        // Setup Plugin
        const rpcEndpoint = `ws://localhost:${gatewayPort}/api`;
        const plugin = new GatewayIntegrationPlugin({ endpoint: rpcEndpoint });
        let state = new RouteTable();
        const context: PluginContext = {
            // @ts-ignore - Dummy action for context, we manipulate state directly
            action: { resource: 'local-routing', action: 'create-datachannel', data: {} },
            state,
            authxContext: {} as any
        };

        // Helper to Query Gateway
        const queryGateway = async (query: string) => {
            const endpoint = `http://localhost:${gatewayPort}/graphql`;
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query })
            });
            const json = await response.json();
            // console.log('Query:', query, 'Response:', JSON.stringify(json));
            return { status: response.status, json: json as any };
        };

        // Helper to trigger plugin update
        const triggerUpdate = async () => {
            const result = await plugin.apply(context);
            expect(result.success).toBe(true);
            // Wait for Gateway to reload
            await new Promise(r => setTimeout(r, 1500));
        };

        // --- Scenario 1: No services gives back the unconfigured message (or empty schema error) ---
        console.log('--- Scenario 1: Unconfigured ---');
        await triggerUpdate();

        const res1 = await queryGateway('{ books { title } }');
        // Expect error because 'books' field doesn't exist yet
        expect(res1.status).toBe(200);
        expect(res1.json.errors).toBeDefined();
        console.log('Verified unconfigured state.');

        // --- Scenario 2: Adding one at a time shows only that data ---
        // --- Scenario 2: Adding one at a time shows only that data ---
        console.log('--- Scenario 2: Add Books ---');
        let updateResult = state.addProxiedRoute({
            name: 'books',
            endpoint: booksUri,
            protocol: 'http:graphql'
        });
        state = updateResult.state;
        const booksId = updateResult.id;
        context.state = state;
        await triggerUpdate();

        const res2a = await queryGateway('{ books { title } }');
        expect(res2a.json.errors).toBeUndefined();
        expect(res2a.json.data.books).toBeDefined();

        const res2b = await queryGateway('{ movies { title } }');
        expect(res2b.json.errors).toBeDefined(); // Movies not yet added
        console.log('Verified Books added, Movies missing.');

        console.log('--- Scenario 2b: Add Movies ---');
        updateResult = state.addProxiedRoute({
            name: 'movies',
            endpoint: moviesUri,
            protocol: 'http:graphql'
        });
        state = updateResult.state;
        const moviesId = updateResult.id;
        context.state = state;
        await triggerUpdate();

        const res3 = await queryGateway('{ books { title } movies { title } }');
        expect(res3.json.data.books).toBeDefined();
        expect(res3.json.data.movies).toBeDefined();
        console.log('Verified both services present.');

        // --- Scenario 3: Deleting one removes the right data ---
        console.log('--- Scenario 3: Delete Books ---');
        // Warning: removeRoute expects ID. createId uses name:protocol.
        // In route-table.ts, createId is private. But the ID returned by addProxiedRoute is what we should use OR construct it.
        // addProxiedRoute returns { state, id }. We should use that ID.
        // BUT the test was passing 'books'.
        // RouteTable.createId = `${service.name}:${service.protocol}`.
        // So ID is 'books:tcp:graphql'.
        // Passing 'books' to removeRoute won't work if ID is complex.

        // Let's check what addProxiedRoute returns as ID.
        // It returns `${name}:${protocol}`.

        // So we need to correct the deletion logic too.
        // Or if the test assumes simple ID usage, we must fix how we call remove.
        // Let's use the ID we presumably got or construct it.

        state = state.removeRoute(booksId);
        context.state = state;
        await triggerUpdate();

        const res4a = await queryGateway('{ books { title } }');
        expect(res4a.json.errors).toBeDefined(); // Books gone

        const res4b = await queryGateway('{ movies { title } }');
        expect(res4b.json.data.movies).toBeDefined(); // Movies stays
        console.log('Verified Books removed, Movies remains.');

        // --- Scenario 4: Deleting both shows unconfigured ---
        console.log('--- Scenario 4: Delete Movies (Empty) ---');
        state = state.removeRoute(moviesId);
        context.state = state;
        await triggerUpdate();

        const res5 = await queryGateway('{ movies { title } }');
        expect(res5.json.errors).toBeDefined();
        console.log('Verified empty state again.');

        // --- Scenario 5: Add one then change it via update to be the other one ---
        console.log('--- Scenario 5: Update/Swap Service ---');

        updateResult = state.addProxiedRoute({
            name: 'dynamic_service',
            endpoint: booksUri,
            protocol: 'http:graphql'
        });
        state = updateResult.state;
        context.state = state;
        await triggerUpdate();

        const res6a = await queryGateway('{ books { title } }');
        expect(res6a.json.data.books).toBeDefined();

        // Update 'dynamic_service' to point to Movies
        // updateProxiedRoute is used.
        const updateRes = state.updateProxiedRoute({
            name: 'dynamic_service',
            endpoint: moviesUri,
            protocol: 'http:graphql'
        });
        if (updateRes) {
            state = updateRes.state;
            context.state = state;
        } else {
            throw new Error('Update failed');
        }
        await triggerUpdate();

        const res6b = await queryGateway('{ movies { title } }');
        expect(res6b.json.data.movies).toBeDefined();

        // Books should be gone
        const res6c = await queryGateway('{ books { title } }');
        expect(res6c.json.errors).toBeDefined();
        console.log('Verified Service Swapped successfully.');

    }, 60_000);
});
