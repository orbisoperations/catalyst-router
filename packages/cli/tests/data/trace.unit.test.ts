import { describe, it, expect, mock } from 'bun:test';
import { DataClient } from '../../src/data-client.js';

describe('Data Plane - Trace Command', () => {
    it('should trace a service successfully', async () => {
        const mockFetch = mock(() =>
            Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ data: { __typename: 'Query' } }),
            })
        );
        global.fetch = mockFetch as unknown as typeof fetch;

        const client = new DataClient({ gatewayUrl: 'http://localhost:4000/graphql' });
        const result = await client.trace('books');

        expect(result.success).toBe(true);
        expect(result.data).toBeDefined();
        expect(result.data?.hops).toBeDefined();
        expect(result.data?.hops.length).toBeGreaterThan(0);
        expect(result.data?.totalLatency).toBeGreaterThanOrEqual(0);
    });

    it('should include trace request header', async () => {
        const mockFetch = mock(() =>
            Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ data: { __typename: 'Query' } }),
            })
        );
        global.fetch = mockFetch as unknown as typeof fetch;

        const client = new DataClient({ gatewayUrl: 'http://localhost:4000/graphql' });
        await client.trace('books');

        expect(mockFetch).toHaveBeenCalled();
        const callArgs = mockFetch.mock.calls[0];
        const headers = (callArgs[1] as RequestInit)?.headers as Record<string, string>;
        expect(headers['X-Trace-Request']).toBe('true');
    });

    it('should handle trace failure', async () => {
        const mockFetch = mock(() => Promise.reject(new Error('Network timeout')));
        global.fetch = mockFetch as unknown as typeof fetch;

        const client = new DataClient({ gatewayUrl: 'http://localhost:4000/graphql' });
        const result = await client.trace('books');

        expect(result.success).toBe(false);
        expect(result.error).toContain('Network timeout');
    });

    it('should capture hop information', async () => {
        const mockFetch = mock(() =>
            Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ data: { __typename: 'Query' } }),
            })
        );
        global.fetch = mockFetch as unknown as typeof fetch;

        const client = new DataClient({ gatewayUrl: 'http://localhost:4000/graphql' });
        const result = await client.trace('books');

        expect(result.success).toBe(true);
        expect(result.data?.hops[0]).toHaveProperty('node');
        expect(result.data?.hops[0]).toHaveProperty('latency');
        expect(result.data?.hops[0]).toHaveProperty('timestamp');
        expect(result.data?.hops[0].node).toBe('Gateway');
    });

    it('should handle HTTP errors in trace', async () => {
        const mockFetch = mock(() =>
            Promise.resolve({
                ok: false,
                status: 503,
                statusText: 'Service Unavailable',
            })
        );
        global.fetch = mockFetch as unknown as typeof fetch;

        const client = new DataClient({ gatewayUrl: 'http://localhost:4000/graphql' });
        const result = await client.trace('books');

        expect(result.success).toBe(false);
        expect(result.error).toContain('503');
    });
});
