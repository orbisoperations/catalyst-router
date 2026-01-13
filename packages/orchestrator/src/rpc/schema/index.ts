
import { z } from 'zod';
import { ServiceDefinitionSchema } from './direct.js';

export * from './direct.js';
export * from './actions.js';

export const DataChannelMetricsSchema = z.object({
    id: z.string(),
    createdAt: z.number(), // Timestamp
    lastConnected: z.number().optional(), // Timestamp
    connectionCount: z.number().default(0),
});
export type DataChannelMetrics = z.infer<typeof DataChannelMetricsSchema>;

export const AddDataChannelResultSchema = z.object({
    success: z.boolean(),
    id: z.string().optional(),
    error: z.string().optional(),
});
export type AddDataChannelResult = z.infer<typeof AddDataChannelResultSchema>;

export const LocalRouteSchema = z.object({
    id: z.string(),
    service: ServiceDefinitionSchema,
});
export type LocalRoute = z.infer<typeof LocalRouteSchema>;

export const ListLocalRoutesResultSchema = z.object({
    routes: z.array(LocalRouteSchema),
});
export type ListLocalRoutesResult = z.infer<typeof ListLocalRoutesResultSchema>;

export const ListMetricsResultSchema = z.object({
    metrics: z.array(DataChannelMetricsSchema),
});
export type ListMetricsResult = z.infer<typeof ListMetricsResultSchema>;
