import { describe, it, expect } from 'vitest';
import { createGraphqlServer } from './graphql/server';
import { createS3GraphqlServer } from './examples/s3-graphql';
import type { Storage } from './storage';

// Mock Storage Implementation
class MockStorage implements Storage {
    private data = new Map<string, Uint8Array>();

    async get(key: string): Promise<Uint8Array | undefined> {
        return this.data.get(key);
    }

    async put(key: string, data: string | Uint8Array): Promise<void> {
        if (typeof data === 'string') {
            this.data.set(key, new TextEncoder().encode(data));
        } else {
            this.data.set(key, data);
        }
    }

    async list(prefix?: string): Promise<string[]> {
        return Array.from(this.data.keys()).filter(k => !prefix || k.startsWith(prefix));
    }
}

describe('GraphQL Integration Tests', () => {
    it('Basic Server: should return hello message', async () => {
        const { yoga } = createGraphqlServer();
        const response = await yoga.fetch('http://localhost:4000/graphql', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: '{ hello }' }),
        });

        const result = await response.json();
        expect(result.data.hello).toBe('Hello from Catalyst SDK!');
    });

    it('S3 Server: should return data from storage', async () => {
        const mockStorage = new MockStorage();
        const testData = { message: 'Test Message', timestamp: '2023-01-01' };
        await mockStorage.put('data.json', JSON.stringify(testData));

        const { yoga } = createS3GraphqlServer(mockStorage);
        const response = await yoga.fetch('http://localhost:4001/graphql', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: '{ s3Data { message timestamp } }' }),
        });

        const result = await response.json();
        expect(result.data.s3Data).toEqual(testData);
    });

    it('S3 Server: should return null if file missing', async () => {
        const mockStorage = new MockStorage();
        const { yoga } = createS3GraphqlServer(mockStorage); // Empty storage

        const response = await yoga.fetch('http://localhost:4001/graphql', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: '{ s3Data { message } }' }),
        });

        const result = await response.json();
        expect(result.data.s3Data).toBeNull();
    });
});
