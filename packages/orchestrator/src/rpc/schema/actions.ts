
import { z } from 'zod';
import { ServiceDefinitionSchema } from './direct.js';

export const DataChannelCreateActionSchema = z.object({
    resource: z.literal('dataChannel'),
    action: z.literal('create'),
    data: ServiceDefinitionSchema,
});

export const DataChannelUpdateActionSchema = z.object({
    resource: z.literal('dataChannel'),
    action: z.literal('update'),
    data: ServiceDefinitionSchema,
});

export const DataChannelDeleteActionSchema = z.object({
    resource: z.literal('dataChannel'),
    action: z.literal('delete'),
    data: z.object({ id: z.string() }),
});

export const InternalPeeringUserCreateActionSchema = z.object({
    resource: z.literal('internal-peering-user'),
    action: z.literal('create'),
    data: z.object({
        endpoint: z.string(),
        secret: z.string()
    }),
});

export const InternalPeeringUserDeleteActionSchema = z.object({
    resource: z.literal('internal-peering-user'),
    action: z.literal('delete'),
    data: z.object({
        id: z.string()
    }),
});

// Import UpdateMessageSchema from peering.ts (circular dependency handling or define here?)
// Defining inline for simplicity to avoid circular dep issues in schema files if possible, 
// OR import if peering.ts is pure data.
// Let's define a minimal UpdateMessage schema here or defer.
// Actually, let's use z.any() for the payload details if complex, or define fully.
// BGP Update Message Structure
const BgpUpdateMessageSchema = z.object({
    type: z.union([z.literal('add'), z.literal('remove')]), // Simplified BGP
    route: ServiceDefinitionSchema.optional(), // present on add
    routeId: z.string().optional() // present on remove
});

export const InternalPeeringProtocolUpdateActionSchema = z.object({
    resource: z.literal('internal-peering-protocol'),
    action: z.literal('update'),
    data: BgpUpdateMessageSchema
});

// Import LocalRouting schemas from the plugin file or define here?
// Ideally define here to keep actions.ts as the source of truth for RPC schema.
// Redefining here to avoid circular dependencies if plugin imports from here.

export const LocalRoutingCreateDataChannelSchema = z.object({
    resource: z.literal('create-datachannel:local-routing'),
    data: ServiceDefinitionSchema,
});

export const LocalRoutingUpdateDataChannelSchema = z.object({
    resource: z.literal('update-datachannel:local-routing'),
    data: ServiceDefinitionSchema,
});

export const LocalRoutingDeleteDataChannelSchema = z.object({
    resource: z.literal('delete-datachannel:local-routing'),
    data: z.object({ id: z.string() }),
});

export const InternalPeeringCreatePeerSchema = z.object({
    resource: z.literal('create-peer:internal-config'),
    data: z.object({
        endpoint: z.string(),
        secret: z.string()
    })
});

export const InternalPeeringOpenSchema = z.object({
    resource: z.literal('open:internal-as'),
    data: z.object({
        peerInfo: z.any(), // TODO: Define strict PeerInfo schema
        clientStub: z.any(), // Validation handled at runtime/plugin level for stubs
        direction: z.enum(['inbound', 'outbound']).optional()
    })
});

export const ActionSchema = z.union([
    LocalRoutingCreateDataChannelSchema,
    LocalRoutingUpdateDataChannelSchema,
    LocalRoutingDeleteDataChannelSchema,
    InternalPeeringUserCreateActionSchema,
    InternalPeeringUserDeleteActionSchema,
    InternalPeeringProtocolUpdateActionSchema,
    InternalPeeringCreatePeerSchema,
    InternalPeeringOpenSchema
]);
export type Action = z.infer<typeof ActionSchema>;

export const ActionResultSchema = z.object({
    success: z.boolean(),
    id: z.string().optional(),
    error: z.string().optional(),
});
export type ActionResult = z.infer<typeof ActionResultSchema>;
