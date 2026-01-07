import { describe, it, expect } from 'vitest';
import { createGraphqlServer } from '../src/graphql/server';

describe('Hello World SDK Test', () => {
    it('should return hello message', async () => {
        const { yoga } = createGraphqlServer();
        const response = await yoga.fetch('http://localhost:4000/graphql', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: '{ hello }' }),
        });

        const result = await response.json();
        expect(result.data.hello).toBe('Hello from Catalyst SDK!');
    });
});
