import type {ICacheService} from "../ports/index.js";
import type {MemoryCacheOptions} from "../domain/index.js";

interface MemoryEntry {
    json: string;
    size: number;
    expiresAt: number;
}

/**
 * Adapter: In-Memory Cache Service (default when no Redis client is configured)
 *
 * A bounded LRU cache with per-entry TTL. Values are stored as JSON, so every read returns a
 * fresh copy: callers can mutate results without corrupting the cache, exactly as with Redis.
 */
export class MemoryCacheService implements ICacheService {
    readonly scope = 'local' as const;

    private readonly entries = new Map<string, MemoryEntry>();
    private readonly maxEntries: number;
    private readonly maxSizeBytes: number;
    private readonly now: () => number;
    private totalSize = 0;

    constructor(options: MemoryCacheOptions & { now?: () => number } = {}) {
        this.maxEntries = options.maxEntries ?? 10_000;
        this.maxSizeBytes = options.maxSizeBytes ?? 64 * 1024 * 1024;
        this.now = options.now ?? Date.now;
    }

    async get<T>(key: string): Promise<T | null> {
        const entry = this.entries.get(key);
        if (!entry) return null;

        if (entry.expiresAt <= this.now()) {
            this.remove(key, entry);
            return null;
        }

        // Re-insert to mark the entry as most recently used
        this.entries.delete(key);
        this.entries.set(key, entry);
        return JSON.parse(entry.json) as T;
    }

    async set<T>(key: string, value: T, ttl: number): Promise<void> {
        this.store(key, value, ttl);
    }

    async delete(key: string): Promise<void> {
        const entry = this.entries.get(key);
        if (entry) this.remove(key, entry);
    }

    async deleteMany(keys: string[]): Promise<void> {
        for (const key of keys) await this.delete(key);
    }

    async deletePattern(pattern: string): Promise<void> {
        const regex = globToRegExp(pattern);
        for (const [key, entry] of this.entries) {
            if (regex.test(key)) this.remove(key, entry);
        }
    }

    async getMultiple<T>(keys: string[]): Promise<Map<string, T>> {
        const map = new Map<string, T>();
        for (const key of keys) {
            const value = await this.get<T>(key);
            if (value !== null) map.set(key, value);
        }
        return map;
    }

    async setMultiple<T>(entries: Array<{ key: string; value: T; ttl: number }>): Promise<void> {
        for (const { key, value, ttl } of entries) this.store(key, value, ttl);
    }

    /** Remove all entries */
    clear(): void {
        this.entries.clear();
        this.totalSize = 0;
    }

    /** Number of entries (including expired ones not yet evicted) */
    get size(): number {
        return this.entries.size;
    }

    /** Approximate memory used by the cached values in bytes */
    get sizeBytes(): number {
        return this.totalSize;
    }

    private store(key: string, value: unknown, ttl: number): void {
        const existing = this.entries.get(key);
        if (existing) this.remove(key, existing);
        if (!(ttl > 0) || value === undefined) return;

        const json = JSON.stringify(value);
        // Strings take up to two bytes per character in V8
        const size = (json.length + key.length) * 2;
        if (size > this.maxSizeBytes) return;

        this.entries.set(key, {json, size, expiresAt: this.now() + ttl * 1000});
        this.totalSize += size;

        // Evict least recently used entries (Map iteration order) until within budget
        for (const [oldKey, oldEntry] of this.entries) {
            if (this.entries.size <= this.maxEntries && this.totalSize <= this.maxSizeBytes) break;
            this.remove(oldKey, oldEntry);
        }
    }

    private remove(key: string, entry: MemoryEntry): void {
        this.entries.delete(key);
        this.totalSize -= entry.size;
    }
}

/**
 * Convert a Redis-style glob (`*` and `?` wildcards) into an anchored regular expression
 */
function globToRegExp(pattern: string): RegExp {
    const source = pattern
        .split('')
        .map(char => char === '*' ? '.*' : char === '?' ? '.' : char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('');
    return new RegExp(`^${source}$`, 's');
}
