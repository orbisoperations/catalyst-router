import { describe, it, expect, mock } from 'bun:test';
import { DataClient } from '../../src/data-client.js';

describe('Data Plane - Query Command', () => {
    it('should execute a GraphQL query successfully', async () => {
        const mockFetch = mock(() =>
            Promise.resolve({
                ok: true,
                json: () => Promise.resolve({
                    data: { books: [{ title: 'Test Book', author: 'Test Author' }] },
                }),
            })
        );
        global.fetch = mockFetch as unknown as typeof fetch;

        const client = new DataClient({ gatewayUrl: 'http://localhost:4000/graphql' });
        const result = await client.query('{ books { title author } }');

        expect(result.success).toBe(true);
        expect(result.data).toHaveProperty('data');
        expect(mockFetch).toHaveBeenCalled();
    });

    it('should handle GraphQL errors', async () => {
        const mockFetch = mock(() =>
            Promise.resolve({
                ok: true,
                json: () => Promise.resolve({
                    errors: [{ message: 'Field not found' }],
                }),
            })
        );
        global.fetch = mockFetch as unknown as typeof fetch;

        const client = new DataClient({ gatewayUrl: 'http://localhost:4000/graphql' });
        const result = await client.query('{ invalidField }');

        expect(result.success).toBe(false);
        expect(result.error).toContain('Field not found');
    });

    it('should handle network errors', async () => {
        const mockFetch = mock(() => Promise.reject(new Error('Network error')));
        global.fetch = mockFetch as unknown as typeof fetch;

        const client = new DataClient({ gatewayUrl: 'http://localhost:4000/graphql' });
        const result = await client.query('{ books { title } }');

        expect(result.success).toBe(false);
        expect(result.error).toContain('Network error');
    });

    it('should handle HTTP errors', async () => {
        const mockFetch = mock(() =>
            Promise.resolve({
                ok: false,
                status: 500,
                statusText: 'Internal Server Error',
            })
        );
        global.fetch = mockFetch as unknown as typeof fetch;

        const client = new DataClient({ gatewayUrl: 'http://localhost:4000/graphql' });
        const result = await client.query('{ books { title } }');

        expect(result.success).toBe(false);
        expect(result.error).toContain('500');
    });

    it('should send authorization header when token is provided', async () => {
        const mockFetch = mock(() =>
            Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ data: {} }),
            })
        );
        global.fetch = mockFetch as unknown as typeof fetch;

        const client = new DataClient({
            gatewayUrl: 'http://localhost:4000/graphql',
            token: 'test-token',
        });
        await client.query('{ books { title } }');

        expect(mockFetch).toHaveBeenCalled();
        const callArgs = mockFetch.mock.calls[0];
        const headers = (callArgs[1] as RequestInit)?.headers as Record<string, string>;
        expect(headers.Authorization).toBe('Bearer test-token');
    });
});
