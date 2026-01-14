
import { z } from 'zod';
import { ServiceDefinitionSchema } from './direct.js';

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

export const UpdateMessageSchema = z.object({
    type: z.union([z.literal('add'), z.literal('remove')]),
    route: ServiceDefinitionSchema.optional(),
    routeId: z.string().optional(),
    path: z.array(z.string()).optional() // BGP AS Path (using Peer IDs for internal peering)
});
export type UpdateMessage = z.infer<typeof UpdateMessageSchema>;

export const ListPeersResultSchema = z.object({
    peers: z.array(AuthorizedPeerSchema)
});
export type ListPeersResult = z.infer<typeof ListPeersResultSchema>;
