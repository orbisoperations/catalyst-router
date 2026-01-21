
import { RpcTarget } from 'capnweb';
import type { KeyManager} from './key-manager.js';
import { FileSystemKeyManager } from './key-manager.js';
import type {
    SignResponse,
    VerifyResponse,
    RotateResponse,
    JwksResponse
} from './rpc-schema.js';
import {
    SignOptionsSchema,
    VerifyRequestSchema,
    RotateRequestSchema
} from './rpc-schema.js';

export class JwtService extends RpcTarget {
    private keyManager: KeyManager;

    constructor(keyManager?: KeyManager) {
        super();
        // Allow injection for testing, default to FileSystemKeyManager
        this.keyManager = keyManager || new FileSystemKeyManager();
        this.init();
    }

    // Ensure KeyManager is initialized (non-blocking in constructor, but awaited in methods)
    private async init() {
        try {
            await this.keyManager.init();
        } catch (e) {
            console.error("Failed to initialize KeyManager:", e);
        }
    }

    async getJwks(): Promise<JwksResponse> {
        const jwks = await this.keyManager.getPublicKeys();
        // Cast to unknown record to match loose schema if needed, but JSONWebKeySet.keys is compatible
        return { keys: jwks.keys as Record<string, unknown>[] };
    }

    async sign(options: unknown): Promise<SignResponse> {
        // Validate input
        const validOptions = SignOptionsSchema.parse(options);

        const token = await this.keyManager.sign(validOptions);
        return { token };
    }

    async verify(req: unknown): Promise<VerifyResponse> {
        const { token } = VerifyRequestSchema.parse(req);

        return await this.keyManager.verify(token);
    }

    async rotate(req: unknown): Promise<RotateResponse> {
        const { immediate } = RotateRequestSchema.parse(req);

        await this.keyManager.rotate(immediate);
        return { success: true };
    }
}
