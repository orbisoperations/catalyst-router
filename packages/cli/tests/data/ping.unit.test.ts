import { describe, it, expect, mock } from 'bun:test';
import { DataClient } from '../../src/data-client.js';

describe('Data Plane - Ping Command', () => {
    it('should ping a service successfully', async () => {
        const mockFetch = mock(() =>
            Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ data: { __typename: 'Query' } }),
            })
        );
        global.fetch = mockFetch as unknown as typeof fetch;

        const client = new DataClient({ gatewayUrl: 'http://localhost:4000/graphql' });
        const result = await client.ping('books');

        expect(result.success).toBe(true);
        expect(result.data).toBeDefined();
        expect(result.data?.success).toBe(true);
        expect(result.data?.latency).toBeGreaterThanOrEqual(0);
        expect(result.data?.timestamp).toBeDefined();
    });

    it('should handle ping failure', async () => {
        const mockFetch = mock(() => Promise.reject(new Error('Connection refused')));
        global.fetch = mockFetch as unknown as typeof fetch;

        const client = new DataClient({ gatewayUrl: 'http://localhost:4000/graphql' });
        const result = await client.ping('books');

        expect(result.success).toBe(false);
        expect(result.error).toContain('Connection refused');
        // Should still provide timing data even on failure
        expect(result.data?.latency).toBeGreaterThanOrEqual(0);
    });

    it('should measure latency', async () => {
        const mockFetch = mock(() => {
            // Simulate some delay
            return new Promise(resolve =>
                setTimeout(() => {
                    resolve({
                        ok: true,
                        json: () => Promise.resolve({ data: { __typename: 'Query' } }),
                    });
                }, 50)
            );
        });
        global.fetch = mockFetch as unknown as typeof fetch;

        const client = new DataClient({ gatewayUrl: 'http://localhost:4000/graphql' });
        const result = await client.ping('books');

        expect(result.success).toBe(true);
        expect(result.data?.latency).toBeGreaterThan(40); // Should be at least 40ms
    });

    it('should handle GraphQL errors in ping', async () => {
        const mockFetch = mock(() =>
            Promise.resolve({
                ok: true,
                json: () => Promise.resolve({
                    errors: [{ message: 'Service unavailable' }],
                }),
            })
        );
        global.fetch = mockFetch as unknown as typeof fetch;

        const client = new DataClient({ gatewayUrl: 'http://localhost:4000/graphql' });
        const result = await client.ping('books');

        expect(result.success).toBe(false);
        expect(result.error).toContain('Service unavailable');
    });
});
