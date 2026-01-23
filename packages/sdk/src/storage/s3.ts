import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import type { Storage } from './index.js';

export class S3Storage implements Storage {
    private client: S3Client;
    private bucket: string;

    constructor(bucket: string, region: string) {
        this.client = new S3Client({ region });
        this.bucket = bucket;
    }

    async get(key: string): Promise<Uint8Array | undefined> {
        try {
            const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
            const response = await this.client.send(command);
            if (response.Body) {
                return await response.Body.transformToByteArray();
            }
            return undefined;
        } catch {
            // Return undefined if Access Denied (often happens if key is missing) or Not Found
            return undefined;
        }
    }

    async put(key: string, data: string | Uint8Array): Promise<void> {
        const command = new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data });
        await this.client.send(command);
    }

    async list(prefix?: string): Promise<string[]> {
        const command = new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix });
        const response = await this.client.send(command);
        return response.Contents?.map((c: { Key?: string }) => c.Key || '').filter(Boolean) || [];
    }
}
