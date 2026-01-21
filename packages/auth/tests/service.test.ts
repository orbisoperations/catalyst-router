
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JwtService } from '../src/service';
import { KeyManager } from '../src/key-manager';
import type { JSONWebKeySet } from 'jose';
import type { SignOptions } from '../src/jwt.js';

// Mock KeyManager implementation
class MockKeyManager extends KeyManager {
    async init() { }
    async rotate(_immediate: boolean) { }
    async sign(_options: SignOptions) { return "signed_token"; }
    async getPublicKeys(): Promise<JSONWebKeySet> { return { keys: [{ kid: '1', kty: 'OKP' }] }; }
    async verify(token: string) {
        if (token === "valid") return { valid: true, payload: { sub: 'user' } };
        return { valid: false, error: 'invalid' };
    }
}

describe('JwtService RPC', () => {
    let service: JwtService;
    let mockKM: MockKeyManager;

    beforeEach(() => {
        mockKM = new MockKeyManager();
        service = new JwtService(mockKM);
        vi.spyOn(mockKM, 'init');
        vi.spyOn(mockKM, 'sign');
        vi.spyOn(mockKM, 'verify');
        vi.spyOn(mockKM, 'rotate');
        vi.spyOn(mockKM, 'getPublicKeys');
    });

    it('should expose getJwks', async () => {
        const res = await service.getJwks();
        expect(res.keys).toHaveLength(1);
        expect(mockKM.getPublicKeys).toHaveBeenCalled();
    });

    it('should expose sign', async () => {
        const res = await service.sign({ subject: 'test', expiresIn: '1h' });
        expect(res.token).toBe('signed_token');
        expect(mockKM.sign).toHaveBeenCalledWith(expect.objectContaining({ subject: 'test' }));
    });

    it('should expose verify', async () => {
        const res = await service.verify({ token: 'valid' });
        expect(res.valid).toBe(true);
        expect(mockKM.verify).toHaveBeenCalledWith('valid');
    });

    it('should expose rotate', async () => {
        const res = await service.rotate({ immediate: true });
        expect(res.success).toBe(true);
        expect(mockKM.rotate).toHaveBeenCalledWith(true);
    });

    it('should validate sign options via Zod', async () => {
        await expect(service.sign({ invalid: 'input' })).rejects.toThrow();
    });
});
