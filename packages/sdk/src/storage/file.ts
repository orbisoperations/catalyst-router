import { readFile, writeFile, mkdir, readdir, stat } from 'fs/promises';
import { join, dirname, relative } from 'path';
import { Storage } from './index';

export class FileStorage implements Storage {
    private rootDir: string;

    constructor(rootDir: string) {
        this.rootDir = rootDir;
    }

    async get(key: string): Promise<Uint8Array | undefined> {
        try {
            const filePath = join(this.rootDir, key);
            return await readFile(filePath);
        } catch (e) {
            return undefined;
        }
    }

    async put(key: string, data: string | Uint8Array): Promise<void> {
        const filePath = join(this.rootDir, key);
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, data);
    }

    async list(prefix: string = ''): Promise<string[]> {
        const files: string[] = [];
        const traverse = async (dir: string) => {
            try {
                const entires = await readdir(dir, { withFileTypes: true });
                for (const entry of entires) {
                    const fullPath = join(dir, entry.name);
                    if (entry.isDirectory()) {
                        await traverse(fullPath);
                    } else {
                        const relPath = relative(this.rootDir, fullPath);
                        if (relPath.startsWith(prefix)) {
                            files.push(relPath);
                        }
                    }
                }
            } catch (e) {
                // ignore if dir doesn't exist
            }
        }
        await traverse(this.rootDir);
        return files;
    }
}
