import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { GenericContainer, Network, Wait, StartedTestContainer, StartedNetwork } from 'testcontainers';
import { join, resolve } from 'path';
import { addService, listServices } from '../src/commands/service.js';

// Increase timeout for builds
const TIMEOUT = 180_000;

describe('CLI E2E with Containers', () => {
    let network: StartedNetwork;
    let gatewayContainer: StartedTestContainer;
    let orchestratorContainer: StartedTestContainer;
    let booksContainer: StartedTestContainer;
    let moviesContainer: StartedTestContainer;

    let gatewayPort: number;
    let orchestratorPort: number;
    let booksUri: string;
    let moviesUri: string;

    beforeAll(async () => {
        network = await new Network().start();

        const repoRoot = resolve(__dirname, '../../..');
        const examplesDir = join(repoRoot, 'packages/examples');
        const gatewayDir = join(repoRoot, 'packages/gateway');
        const orchestratorDir = join(repoRoot, 'packages/orchestrator');

        console.log('Building Docker images...');

        const buildBooks = async () => {
            await Bun.spawn(['docker', 'build', '-t', 'books-service:test', '-f', 'Dockerfile.books', '.'], {
                cwd: examplesDir,
                stdout: 'ignore',
                stderr: 'inherit'
            }).exited;
        };

        const buildMovies = async () => {
            await Bun.spawn(['docker', 'build', '-t', 'movies-service:test', '-f', 'Dockerfile.movies', '.'], {
                cwd: examplesDir,
                stdout: 'ignore',
                stderr: 'inherit'
            }).exited;
        };

        const buildGateway = async () => {
            await Bun.spawn(['docker', 'build', '-t', 'gateway-service:test', '.'], {
                cwd: gatewayDir,
                stdout: 'ignore',
                stderr: 'inherit'
            }).exited;
        };

        // We build orchestrator manually instead of using existing image to ensure fresh code
        const buildOrchestrator = async () => {
            await Bun.spawn(['docker', 'build', '-t', 'orchestrator-service:test', '.'], {
                cwd: orchestratorDir,
                stdout: 'ignore',
                stderr: 'inherit'
            }).exited;
        }

        await Promise.all([buildBooks(), buildMovies(), buildGateway(), buildOrchestrator()]);
        console.log('Docker images built successfully.');

        console.log('Starting Containers...');

        booksContainer = await new GenericContainer('books-service:test')
            .withExposedPorts(8080)
            .withNetwork(network)
            .withNetworkAliases('books')
            .withStartupTimeout(180_000)
            .withWaitStrategy(Wait.forHttp('/health', 8080))
            .start();

        const booksPort = booksContainer.getMappedPort(8080);
        // Inside docker network, use alias
        booksUri = 'http://books:8080/graphql';
        console.log(`Books started on port ${booksPort}`);

        moviesContainer = await new GenericContainer('movies-service:test')
            .withExposedPorts(8080)
            .withNetwork(network)
            .withNetworkAliases('movies')
            .withStartupTimeout(180_000)
            .withWaitStrategy(Wait.forHttp('/health', 8080))
            .start();

        moviesUri = 'http://movies:8080/graphql';

        gatewayContainer = await new GenericContainer('gateway-service:test')
            .withExposedPorts(4000)
            .withNetwork(network)
            .withNetworkAliases('gateway')
            .withStartupTimeout(180_000)
            .withWaitStrategy(Wait.forHttp('/', 4000))
            .start();

        gatewayPort = gatewayContainer.getMappedPort(4000);
        console.log(`Gateway started on port ${gatewayPort}`);

        orchestratorContainer = await new GenericContainer('orchestrator-service:test')
            .withExposedPorts(3000)
            .withNetwork(network)
            .withNetworkAliases('orchestrator')
            // Tell Orchestrator where Gateway is (internal docker network alias)
            .withEnvironment({
                CATALYST_GQL_GATEWAY_ENDPOINT: 'ws://gateway:4000/api',
                PORT: '3000'
            })
            .withStartupTimeout(180_000)
            .withWaitStrategy(Wait.forHttp('/health', 3000))
            .start();

        orchestratorPort = orchestratorContainer.getMappedPort(3000);
        console.log(`Orchestrator started on port ${orchestratorPort}`);

        // --- Configure CLI to point to this Orchestrator ---
        process.env.CATALYST_ORCHESTRATOR_URL = `ws://localhost:${orchestratorPort}/rpc`;

    }, TIMEOUT);

    afterAll(async () => {
        await moviesContainer?.stop();
        await booksContainer?.stop();
        await gatewayContainer?.stop();
        await orchestratorContainer?.stop();
        await network?.stop();
    });

    it('should add services via CLI and reflect in list', async () => {
        // 1. Initial State: Empty
        console.log('--- Step 1: List Empty ---');
        const listRes1 = await listServices();
        expect(listRes1.success).toBe(true);
        if (listRes1.success) {
            expect(listRes1.data).toHaveLength(0);
        }

        // 2. Add Books
        console.log('--- Step 2: Add Books ---');
        const addRes1 = await addService({
            name: 'books',
            endpoint: booksUri,
            protocol: 'tcp:graphql'
        });
        expect(addRes1.success).toBe(true);

        // 3. Verify List has Books
        console.log('--- Step 3: Verify Books ---');
        const listRes2 = await listServices();
        expect(listRes2.success).toBe(true);
        if (listRes2.success) {
            expect(listRes2.data).toHaveLength(1);
            expect(listRes2.data![0].service.name).toBe('books');
            expect(listRes2.data![0].service.endpoint).toBe(booksUri);
        }

        // 4. Add Movies
        console.log('--- Step 4: Add Movies ---');
        const addRes2 = await addService({
            name: 'movies',
            endpoint: moviesUri,
            protocol: 'tcp:graphql'
        });
        expect(addRes2.success).toBe(true);

        // 5. Verify List has Both
        console.log('--- Step 5: Verify Both ---');
        const listRes3 = await listServices();
        expect(listRes3.success).toBe(true);
        if (listRes3.success) {
            expect(listRes3.data).toHaveLength(2);
            const names = listRes3.data!.map(d => d.service.name).sort();
            expect(names).toEqual(['books', 'movies']);
        }

        // 6. Verify Metrics
        console.log('--- Step 6: Verify Metrics ---');
        const { fetchMetrics } = await import('../src/commands/metrics.js');
        const metricsRes = await fetchMetrics();
        expect(metricsRes.success).toBe(true);
        if (metricsRes.success) {
            expect(metricsRes.data).toBeDefined();
            // Metrics might be empty or match routes, just verify success and structure
            expect(metricsRes.data.metrics).toBeDefined();
        }

        // Note: We could verify gateway connectivity here too by querying localhost:${gatewayPort},
        // but that logic is covered in orchestrator's integration test. 
        // Here we focus on: CLI -> Orchestrator communication.
    });
});
