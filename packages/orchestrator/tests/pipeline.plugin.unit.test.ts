
import { describe, it, expect, mock } from 'bun:test';
import { PluginPipeline } from '../src/plugins/pipeline.js';
import { BasePlugin } from '../src/plugins/base.js';
import { PluginContext, PluginResult, ActionSchema, AuthContextSchema } from '../src/plugins/types.js';
import { RouteTable } from '../src/state/route-table.js';

// Mock Implementation for testing
class MockPlugin extends BasePlugin {
    constructor(public name: string, private fn: (ctx: PluginContext) => Promise<PluginResult>) {
        super();
    }

    async apply(context: PluginContext): Promise<PluginResult> {
        return this.fn(context);
    }
}

describe('PluginPipeline Unit Tests', () => {
    // Helper to generic valid context
    const createTestContext = (): PluginContext => ({
        action: { resource: 'local-routing', action: 'create-datachannel', data: { name: 'test', endpoint: 'http://test', protocol: 'tcp' } },
        state: new RouteTable(),
        authxContext: { userId: 'test-user' },
        result: {}
    });

    it('should execute plugins sequentially', async () => {
        const executionOrder: string[] = [];

        const plugin1 = new MockPlugin('Plugin1', async (ctx) => {
            executionOrder.push('Plugin1');
            return { success: true, ctx };
        });

        const plugin2 = new MockPlugin('Plugin2', async (ctx) => {
            executionOrder.push('Plugin2');
            return { success: true, ctx };
        });

        const pipeline = new PluginPipeline([plugin1, plugin2]);
        const result = await pipeline.apply(createTestContext());

        expect(result.success).toBe(true);
        expect(executionOrder).toEqual(['Plugin1', 'Plugin2']);
    });

    it('should modify context across plugins', async () => {
        const plugin1 = new MockPlugin('Mutator1', async (ctx) => {
            ctx.result = { ...ctx.result, step1: true };
            return { success: true, ctx };
        });

        const plugin2 = new MockPlugin('Mutator2', async (ctx) => {
            ctx.result = { ...ctx.result, step2: true };
            return { success: true, ctx };
        });

        const pipeline = new PluginPipeline([plugin1, plugin2]);
        const result = await pipeline.apply(createTestContext());

        if (result.success) {
            expect(result.ctx.result).toEqual({ step1: true, step2: true });
        } else {
            throw new Error('Pipeline failed unexpectedly');
        }
    });

    it('should stop execution on failure', async () => {
        const plugin1 = new MockPlugin('FailPlugin', async (ctx) => {
            return {
                success: false,
                error: { pluginName: 'FailPlugin', message: 'Intentional Failure' }
            };
        });

        const plugin2 = new MockPlugin('SkippedPlugin', async (ctx) => {
            throw new Error('Should not run');
        });

        const pipeline = new PluginPipeline([plugin1, plugin2]);
        const result = await pipeline.apply(createTestContext());

        expect(result.success).toBe(false);
        if (!result.success) { // logic guard
            expect(result.error.pluginName).toBe('FailPlugin');
            expect(result.error.message).toBe('Intentional Failure');
        }
    });

    it('should catch exceptions and return typed error', async () => {
        const plugin1 = new MockPlugin('ThrowingPlugin', async (ctx) => {
            throw new Error('Uncaught Exception');
        });

        const pipeline = new PluginPipeline([plugin1]);
        const result = await pipeline.apply(createTestContext());

        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.pluginName).toBe('ThrowingPlugin');
            expect(result.error.message).toContain('Unexpected error: Uncaught Exception');
        }
    });

    it('should support recursive pipelines (Pipeline as a Plugin)', async () => {
        const executionOrder: string[] = [];

        const subPlugin = new MockPlugin('SubPlugin', async (ctx) => {
            executionOrder.push('SubPlugin');
            return { success: true, ctx };
        });

        const subPipeline = new PluginPipeline([subPlugin], 'SubPipeline');

        const wrapperPlugin = new MockPlugin('Wrapper', async (ctx) => {
            executionOrder.push('Wrapper');
            return { success: true, ctx };
        });

        const mainPipeline = new PluginPipeline([wrapperPlugin, subPipeline]);

        const result = await mainPipeline.apply(createTestContext());

        expect(result.success).toBe(true);
        expect(executionOrder).toEqual(['Wrapper', 'SubPlugin']);
    });
});
