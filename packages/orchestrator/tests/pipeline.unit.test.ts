
import { describe, it, expect } from 'bun:test';
import { PluginPipeline } from '../src/plugins/pipeline.js';
import type { PluginInterface } from '../src/plugins/types.js';
import { RouteTable } from '../src/state/route-table.js';

describe('PluginPipeline', () => {
    it('should propagate state updates', async () => {
        const initialState = new RouteTable();
        const updatedState = new RouteTable(); // distinct instance using internal cloning if we want, or just new

        // We can simulate state update by checking reference equality
        const mockPlugin: PluginInterface = {
            name: 'MockPlugin',
            apply: async (ctx) => {
                // Simulate plugin modifying state (returning new state)
                ctx.state = updatedState;
                return { success: true, ctx };
            }
        };

        const pipeline = new PluginPipeline([mockPlugin]);
        const result = await pipeline.apply({
            action: {} as any,
            state: initialState,
            authxContext: { userId: 'test', roles: [] },
            results: []
        });

        if (!result.success) {
            throw new Error('Pipeline failed');
        }

        expect(result.ctx.state).toBe(updatedState);
        expect(result.ctx.state).not.toBe(initialState);
    });
});
