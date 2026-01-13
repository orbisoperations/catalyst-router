import { describe, it, expect } from 'bun:test';
import booksServer from '../src/books/index.ts';
import moviesServer from '../src/movies/index.ts';

describe('Local Examples Integration', () => {
    describe('Books Service (Local)', () => {
        it('should serve books', async () => {
            const req = new Request('http://localhost/graphql', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    query: '{ books { title } }'
                })
            });
            const res = await booksServer.fetch(req);
            expect(res.status).toBe(200);
            const data: any = await res.json();
            expect(data.data.books).toBeDefined();
            expect(data.data.books[0]).toHaveProperty('title');
        });
    });

    describe('Movies Service (Local)', () => {
        it('should serve movies', async () => {
            const req = new Request('http://localhost/graphql', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    query: '{ movies { title } }'
                })
            });
            const res = await moviesServer.fetch(req);
            expect(res.status).toBe(200);
            const data: any = await res.json();
            expect(data.data.movies).toBeDefined();
            expect(data.data.movies[0]).toHaveProperty('title');
        });
    });
});
