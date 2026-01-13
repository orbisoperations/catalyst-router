
import { describe, it, expect } from 'bun:test';
import { ExternalRouteTablePlugin } from '../src/plugins/implementations/external-routing.js';
import { PluginContext } from '../src/plugins/types.js';
import { RouteTable } from '../src/state/route-table.js';

describe('External Validation Tests', () => {
    it('should accept external route with valid JWKS (stub)', async () => {
        const plugin = new ExternalRouteTablePlugin();
        const state = new RouteTable();
        const context: PluginContext = {
            action: {
                resource: 'externalRoute',
                action: 'create',
                data: {
                    name: 'remote-service',
                    fqdn: 'service.remote',
                    endpoint: 'http://remote:8080',
                    protocol: 'tcp:http',
                    jwks: 'https://remote.com/.well-known/jwks.json'
                }
            },
            state,
            authxContext: {} as any
        };

        const result = await plugin.apply(context);
        if (!result.success) throw new Error(JSON.stringify(result));
        expect(result.ctx.state.getExternalRoutes()).toHaveLength(1);
        expect(result.ctx.state.getExternalRoutes()[0].service.jwks).toBe('https://remote.com/.well-known/jwks.json');
    });
});
