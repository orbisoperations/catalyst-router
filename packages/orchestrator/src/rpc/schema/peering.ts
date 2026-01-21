import { z } from 'zod';
import { ServiceDefinitionSchema } from './direct.js';
import type { ApplyActionResult } from './index.js';

// --- iBGP Route Table ---
export const AuthorizedPeerSchema = z.object({
    id: z.string(),
    as: z.number(),
    endpoint: z.string(),
    domains: z.array(z.string())
});
export type AuthorizedPeer = z.infer<typeof AuthorizedPeerSchema>;

export const PeerInfoSchema = z.object({
    id: z.string(),
    as: z.number(),
    endpoint: z.string(),
    domains: z.array(z.string())
});
export type PeerInfo = z.infer<typeof PeerInfoSchema>;

export const UpdateMesssageAddSchema = z.object({
    type: z.literal('add'),
    route: ServiceDefinitionSchema,
    asPath: z.array(z.number()).optional(),
});

export const UpdateMesssageRemoveSchema = z.object({
    type: z.literal('remove'),
    routeId: z.string(),
});

export const UpdateMessageSchema = z.discriminatedUnion('type', [
    UpdateMesssageAddSchema,
    UpdateMesssageRemoveSchema
]);

export type UpdateMessage = z.infer<typeof UpdateMessageSchema>;

export const ListPeersResultSchema = z.object({
    peers: z.array(AuthorizedPeerSchema)
});
export type ListPeersResult = z.infer<typeof ListPeersResultSchema>;

// --- iBGP Peering Actions ---
export const IBGPConfigResource = z.literal('internalBGPConfig');
export const IBGPConfigResourceAction = z.enum([
    'create',
    'update',
    'delete'
]);

export const IBGPConfigCreatePeerSchema = z.object({
    resource: IBGPConfigResource,
    resourceAction: z.literal(IBGPConfigResourceAction.enum.create),
    data: z.object({
        endpoint: z.string(),
        domains: z.array(z.string()).optional()
    })
});

export const IBGPConfigUpdatePeerSchema = z.object({
    resource: IBGPConfigResource,
    resourceAction: z.literal(IBGPConfigResourceAction.enum.update),
    data: z.object({
        peerId: z.string(),
        endpoint: z.string(),
        domains: z.array(z.string()).optional()
    })
});

export const IBGPConfigDeletePeerSchema = z.object({
    resource: IBGPConfigResource,
    resourceAction: z.literal(IBGPConfigResourceAction.enum.delete),
    data: z.object({
        peerId: z.string()
    })
});

export const IBGPConfigSchema = z.discriminatedUnion('resourceAction', [
    IBGPConfigCreatePeerSchema,
    IBGPConfigUpdatePeerSchema,
    IBGPConfigDeletePeerSchema
]);

export type IBGPConfig = z.infer<typeof IBGPConfigSchema>;


export const IBGPProtocolResource = z.literal('internalBGP');
export const IBGPProtocolResourceAction = z.enum([
    'open',
    'close',
    'keepAlive',
    'update'
]);


export const IBGPProtocolOpenSchema = z.object({
    resource: IBGPProtocolResource,
    resourceAction: z.literal(IBGPProtocolResourceAction.enum.open),
    data: z.object({
        peerInfo: PeerInfoSchema,
    })
});

export const IBGPProtocolCloseSchema = z.object({
    resource: IBGPProtocolResource,
    resourceAction: z.literal(IBGPProtocolResourceAction.enum.close),
    data: z.object({
        peerInfo: PeerInfoSchema.omit({ domains: true }),
    })
});

export const IBGPProtocolKeepAliveSchema = z.object({
    resource: IBGPProtocolResource,
    resourceAction: z.literal(IBGPProtocolResourceAction.enum.keepAlive),
    data: z.object({
        peerInfo: PeerInfoSchema.omit({ domains: true }),
    })
});

export const IBGPProtocolUpdateSchema = z.object({
    resource: IBGPProtocolResource,
    resourceAction: z.literal(IBGPProtocolResourceAction.enum.update),
    data: z.object({
        peerInfo: PeerInfoSchema,
        updateMessages: z.array(UpdateMessageSchema),
    })
});

export const IBGPProtocolSchema = z.discriminatedUnion('resourceAction', [
    IBGPProtocolOpenSchema,
    IBGPProtocolCloseSchema,
    IBGPProtocolKeepAliveSchema,
    IBGPProtocolUpdateSchema
]);

export type IBGPProtocol = z.infer<typeof IBGPProtocolSchema>;
export type IBGPProtocolOpen = z.infer<typeof IBGPProtocolOpenSchema>;
export type IBGPProtocolClose = z.infer<typeof IBGPProtocolCloseSchema>;
export type IBGPProtocolUpdate = z.infer<typeof IBGPProtocolUpdateSchema>;

export const IBGPOpenResultSuccessSchema = z.object({
    success: z.literal(true),
    peerInfo: PeerInfoSchema
});

export const IBGPOpenResultFailureSchema = z.object({
    success: z.literal(false),
    error: z.string().optional()
});

export const IBGPOpenResultSchema = z.discriminatedUnion('success', [
    IBGPOpenResultSuccessSchema,
    IBGPOpenResultFailureSchema
]);
export type IBGPOpenResult = z.infer<typeof IBGPOpenResultSchema>;

export interface IBGPScope {
    open(peerInfo: PeerInfo): Promise<IBGPOpenResult>;
    update(peerInfo: PeerInfo, routes: UpdateMessage[]): Promise<ApplyActionResult>;
    close(peerInfo: PeerInfo): Promise<ApplyActionResult>;
}

export interface PublicIBGPScope {
    connectToIBGPPeer(secret: string): IBGPScope;
}
