import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { addService, listServices } from '../src/commands/service.js';

// Mock the client creation
const mockApplyAction = mock((action: any) => Promise.resolve({ success: true, error: undefined as string | undefined }));
const mockListLocalRoutes = mock(() => Promise.resolve({ routes: [] as any[] }));

const mockCreateClient = mock(() => Promise.resolve({
    applyAction: mockApplyAction,
    listLocalRoutes: mockListLocalRoutes
} as any));

mock.module('../src/client.js', () => {
    return {
        createClient: mockCreateClient
    };
});

describe('Service Commands', () => {
    beforeEach(() => {
        mockApplyAction.mockClear();
        mockListLocalRoutes.mockClear();
        mockCreateClient.mockClear();
        // Reset default implementation if needed, but here we rely on default returning the object
        // and override using mockResolvedValue logic only when needed, but primarily we want the default behavior.
        // If a test changed implementation, we must reset it.
        mockCreateClient.mockImplementation(() => Promise.resolve({
            applyAction: mockApplyAction,
            listLocalRoutes: mockListLocalRoutes
        } as any));
    });

    describe('addService', () => {
        it('should add a service successfully', async () => {
            const result = await addService({ name: 'test-service', endpoint: 'http://localhost:8080', protocol: 'tcp:graphql' });
            expect(result.success).toBe(true);
            expect(mockApplyAction).toHaveBeenCalled();
            const lastCall = mockApplyAction.mock.calls[0][0];
            expect(lastCall).toEqual({
                resource: 'localRoute',
                resourceAction: 'create',
                data: {
                    name: 'test-service',
                    endpoint: 'http://localhost:8080',
                    protocol: 'tcp:graphql'
                }
            });
        });

        it('should handle failure when adding service', async () => {
            mockApplyAction.mockImplementationOnce(() => Promise.resolve({ success: false, error: 'Failed' }));
            const result = await addService({ name: 'fail', endpoint: 'err', protocol: 'tcp:graphql' });
            expect(result.success).toBe(false);
            if (!result.success) { // logic check
                expect(result.error).toBe('Failed');
            }
        });

        it('should handle connection errors', async () => {
            mockCreateClient.mockRejectedValueOnce(new Error('Connect Error'));
            const result = await addService({ name: 'fail', endpoint: 'err', protocol: 'tcp:graphql' });
            expect(result.success).toBe(false);
            if (!result.success) {
                expect(result.error).toContain('Connect Error');
            }
        });
    });

    describe('listServices', () => {
        it('should list services', async () => {
            mockListLocalRoutes.mockResolvedValueOnce({ routes: [{ name: 's1', endpoint: 'url' }] });
            const result = await listServices();
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data).toHaveLength(1);
                expect(result.data![0].name).toBe('s1');
            }
        });
    });
});
