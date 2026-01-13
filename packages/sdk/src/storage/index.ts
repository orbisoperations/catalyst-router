export interface Storage {
    get(key: string): Promise<Uint8Array | undefined>;
    put(key: string, data: string | Uint8Array): Promise<void>;
    list(prefix?: string): Promise<string[]>;
}
