import { z } from 'zod';
import { localPeerCreateMessageSchema, localPeerUpdateMessageSchema, localPeerDeleteMessageSchema, localRouteCreateMessageSchema, localRouteDeleteMessageSchema } from './routing/local/actions.js';
import { InternalProtocolOpenMessageSchema, InternalProtocolUpdateMessageSchema, InternalProtocolCloseMessageSchema, InternalProtocolConnectedMessageSchema } from './routing/internal/actions.js';

/**
 * Unified Action Schema
 */
export const ActionSchema = z.discriminatedUnion('action', [
    localPeerCreateMessageSchema,
    localPeerUpdateMessageSchema,
    localPeerDeleteMessageSchema,
    localRouteCreateMessageSchema,
    localRouteDeleteMessageSchema,
    InternalProtocolOpenMessageSchema,
    InternalProtocolUpdateMessageSchema,
    InternalProtocolCloseMessageSchema,
    InternalProtocolConnectedMessageSchema,
]);

export type Action = z.infer<typeof ActionSchema>;
