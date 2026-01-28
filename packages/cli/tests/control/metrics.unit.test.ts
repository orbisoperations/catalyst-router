import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { fetchMetrics } from '../../src/commands/control/metrics.js';

const mockListMetrics = mock(() => Promise.resolve({ uptime: 100 }));

mock.module('../../src/client.js', () => {
    return {
        createClient: async () => ({
            connectionFromManagementSDK: () => ({
                listMetrics: mockListMetrics
            })
        })
    };
});

describe('Metrics Commands', () => {
    beforeEach(() => {
        mockListMetrics.mockClear();
    });

    it('should fetch metrics successfully', async () => {
        const result = await fetchMetrics();
        expect(result.success).toBe(true);
        expect(mockListMetrics).toHaveBeenCalled();
        if (result.success) {
            expect(result.data).toEqual({ uptime: 100 });
        }
    });

    it('should handle failures', async () => {
        mockListMetrics.mockRejectedValueOnce(new Error('RPC Fail'));
        const result = await fetchMetrics();
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error).toBe('RPC Fail');
        }
    });
});
