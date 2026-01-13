import { z } from 'zod';
// import { RpcPromise } from 'capnweb'; // Assuming capnweb types are available or mocked
// If capnweb is not installed, we might need to define RpcPromise ourselves or use 'any' for now basically.
// Re-reading user request: "uses TypeScript... we declare our interface in a shared types file"
// We will define the interfaces.
// The user said: "let authedApi: RpcPromise<AuthedApi> = api.authenticate(apiToken);"
// So we need RpcPromise generic.

// For now, let's define RpcPromise as a generic Promise that also carries the methods of T return values?
// Actually, `capnweb` RpcPromise is magic. Since we might not have `capnweb` package installed in the orchestrator yet 
// (I should check package.json), defining it as type RpcPromise<T> = Promise<T> & T is a common mock for these RPCs in TS.
// Or if the user actually has `capnweb`.

// Checking imports in previous files... I don't see `capnweb`.
// I will definte a helper type.

export type RpcPromise<T> = Promise<T> & { [K in keyof T]: T[K] extends (...args: any[]) => any ? (...args: Parameters<T[K]>) => RpcPromise<ReturnType<T[K]>> : never };

export const PeerInfoSchema = z.object({
    id: z.string(),
    as: z.number(),
    endpoint: z.string().url(),
    domains: z.array(z.string()),
    // Capabilities etc.
});
export type PeerInfo = z.infer<typeof PeerInfoSchema>;

export const UpdateMessageSchema = z.object({
    advertise: z.array(z.string()).optional(), // List of route IDs or Prefixes
    withdraw: z.array(z.string()).optional(),
    nextHop: z.string().optional(),
});
export type UpdateMessage = z.infer<typeof UpdateMessageSchema>;

export const PeerSessionStateSchema = z.object({
    accepted: z.boolean(),
    peers: z.array(PeerInfoSchema),
    domains: z.array(z.string()),
    authEndpoint: z.string().optional(),
    jwks: z.any().optional(), // TODO: Define JWKS schema
});
export type PeerSessionState = z.infer<typeof PeerSessionStateSchema>;

export const ListPeersResultSchema = z.object({
    peers: z.array(PeerInfoSchema),
});
export type ListPeersResult = z.infer<typeof ListPeersResultSchema>;


// ----------------------------------------------------------------------
// RPC Interfaces
// ----------------------------------------------------------------------

// Interface implemented by the Initiator (Client) to receive callbacks
export interface PeerClient {
    keepAlive(): Promise<void>;
    updateRoute(msg: UpdateMessage): Promise<void>;
    close(): Promise<void>;
}

// Privileged Interface returned after authentication
export interface AuthorizedPeer {
    open(info: PeerInfo, clientStub: PeerClient): Promise<PeerSessionState>;
    keepAlive(): Promise<void>;
    updateRoute(msg: UpdateMessage): Promise<void>;
    close(): Promise<void>;
}

// Public Interface exposed by every node
export interface PeerPublicApi {
    authenticate(secret: string): AuthorizedPeer; // RpcPromise<AuthorizedPeer> in usage
    ping(): Promise<string>;
}
