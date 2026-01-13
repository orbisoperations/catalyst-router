
import { RpcTarget } from 'capnweb';
import { KeyManager, FileSystemKeyManager } from './key-manager.js';
import {
    SignOptionsSchema,
    SignResponse,
    VerifyRequestSchema,
    VerifyResponse,
    RotateRequestSchema,
    RotateResponse,
    JwksResponse,
    RevokeRequestSchema,
    RevokeResponse,
} from './rpc-schema.js';
import { type RevocationStore, revokeToken } from './revocation.js';

export class JwtService extends RpcTarget {
    private keyManager: KeyManager;
    private revocationStore?: RevocationStore;

    constructor(keyManager?: KeyManager, revocationStore?: RevocationStore) {
        super();
        // Allow injection for testing, default to FileSystemKeyManager
        this.keyManager = keyManager || new FileSystemKeyManager();
        this.revocationStore = revocationStore;
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

        const result = await this.keyManager.verify(token);

        // Check revocation if enabled and token is valid
        if (result.valid && this.revocationStore) {
            const jti = result.payload?.jti;
            if (typeof jti === 'string' && this.revocationStore.isRevoked(jti)) {
                return { valid: false, error: 'Token revoked' };
            }
        }

        return result;
    }

    async rotate(req: unknown): Promise<RotateResponse> {
        const { immediate } = RotateRequestSchema.parse(req);

        await this.keyManager.rotate(immediate);
        return { success: true };
    }

    async revoke(req: unknown): Promise<RevokeResponse> {
        const { token, authToken } = RevokeRequestSchema.parse(req);

        if (!this.revocationStore) {
            return { success: false, error: 'Revocation not enabled' };
        }

        // Get current key for verification
        const keyPair = await this.keyManager.getCurrentKeyPair();
        return revokeToken({ store: this.revocationStore, keyPair, token, authToken });
    }
}
