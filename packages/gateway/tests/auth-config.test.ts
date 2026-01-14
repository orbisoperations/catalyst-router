import { describe, it, expect } from 'bun:test';
import { GatewayConfigSchema } from '../src/rpc/server.js';

describe('Gateway Auth Config Schema', () => {
    it('should accept config without auth settings', () => {
        const config = {
            services: [
                { name: 'books', url: 'http://books:8080/graphql' }
            ]
        };

        const result = GatewayConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
    });

    it('should accept config with auth settings', () => {
        const config = {
            services: [
                { name: 'books', url: 'http://books:8080/graphql' }
            ],
            auth: {
                jwksUrl: 'http://auth:4020/.well-known/jwks.json',
            }
        };

        const result = GatewayConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.auth?.jwksUrl).toBe('http://auth:4020/.well-known/jwks.json');
        }
    });

    it('should accept auth config with optional issuer and audience', () => {
        const config = {
            services: [],
            auth: {
                jwksUrl: 'http://auth:4020/.well-known/jwks.json',
                issuer: 'catalyst-auth',
                audience: 'catalyst-gateway',
            }
        };

        const result = GatewayConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.auth?.issuer).toBe('catalyst-auth');
            expect(result.data.auth?.audience).toBe('catalyst-gateway');
        }
    });

    it('should reject auth config with invalid jwksUrl', () => {
        const config = {
            services: [],
            auth: {
                jwksUrl: 'not-a-url',
            }
        };

        const result = GatewayConfigSchema.safeParse(config);
        expect(result.success).toBe(false);
    });
});
