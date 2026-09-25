import type {ICacheService} from "../ports/index.js";
import type {CacheConfig, RedisClientLike} from "../domain/index.js";

const SCAN_BATCH = 500;

/**
 * Adapter: Redis Cache Service
 *
 * Works with any client matching {@link RedisClientLike}, e.g. `ioredis` `Redis` or `Cluster`.
 * Uses non-blocking SCAN/UNLINK instead of KEYS/DEL and never sends multi-key commands
 * across cluster slots.
 */
export class RedisCacheService<TClient extends RedisClientLike = RedisClientLike> implements ICacheService {
    readonly scope = 'shared' as const;

    private readonly ttl: {
        events: number;
        snapshots: number;
        sequences: number;
        aggregateEvents: number;
    };
    private readonly keyPrefix: string;

    constructor(
        private readonly redis: TClient,
        config: CacheConfig = {}
    ) {
        this.ttl = {
            events: config.ttl?.events ?? 3600,
            snapshots: config.ttl?.snapshots ?? 7200,
            sequences: config.ttl?.sequences ?? 300,
            aggregateEvents: config.ttl?.aggregateEvents ?? 1800,
        };
        this.keyPrefix = config.keyPrefix ?? 'es:';
    }

    async get<T>(key: string): Promise<T | null> {
        try {
            const data = await this.redis.get(key);
            return data ? JSON.parse(data) : null;
        } catch (err) {
            console.error('Cache read error:', err);
            return null;
        }
    }

    async set<T>(key: string, value: T, ttl: number): Promise<void> {
        if (!(ttl > 0) || value === undefined) return;

        try {
            await this.redis.set(key, JSON.stringify(value), 'EX', Math.ceil(ttl));
        } catch (err) {
            console.error('Cache write error:', err);
        }
    }

    async delete(key: string): Promise<void> {
        try {
            await this.redis.unlink(key);
        } catch (err) {
            console.error('Cache delete error:', err);
        }
    }

    async deleteMany(keys: string[]): Promise<void> {
        if (keys.length === 0) return;

        try {
            // One command per key: keys of an aggregate may live in different cluster slots
            await Promise.all(keys.map(key => this.redis.unlink(key)));
        } catch (err) {
            console.error('Cache delete error:', err);
        }
    }

    async deletePattern(pattern: string): Promise<void> {
        try {
            await Promise.all(this.scanNodes().map(async node => {
                for await (const keys of scanKeys(node, pattern)) {
                    if (keys.length === 0) continue;
                    if (this.redis.nodes) {
                        await Promise.all(keys.map(key => node.unlink(key)));
                    } else {
                        await node.unlink(...keys);
                    }
                }
            }));
        } catch (err) {
            console.error('Cache pattern delete error:', err);
        }
    }

    async getMultiple<T>(keys: string[]): Promise<Map<string, T>> {
        if (keys.length === 0) return new Map();

        const values = await Promise.all(keys.map(key => this.get<T>(key)));
        const map = new Map<string, T>();
        values.forEach((value, index) => {
            if (value !== null) map.set(keys[index], value);
        });
        return map;
    }

    async setMultiple<T>(entries: Array<{ key: string; value: T; ttl: number }>): Promise<void> {
        await Promise.all(entries.map(({key, value, ttl}) => this.set(key, value, ttl)));
    }

    /**
     * Count keys matching a pattern (uses SCAN, safe on large keyspaces)
     */
    async countKeys(pattern: string): Promise<number> {
        const counts = await Promise.all(this.scanNodes().map(async node => {
            let count = 0;
            for await (const keys of scanKeys(node, pattern)) count += keys.length;
            return count;
        }));
        return counts.reduce((sum, count) => sum + count, 0);
    }

    buildCacheKey(...parts: string[]): string {
        return `${this.keyPrefix}${parts.join(':')}`;
    }

    getTTL(type: 'events' | 'snapshots' | 'sequences' | 'aggregateEvents'): number {
        return this.ttl[type] ?? 0;
    }

    getRedisClient(): TClient {
        return this.redis;
    }

    private scanNodes(): RedisClientLike[] {
        return this.redis.nodes ? this.redis.nodes('master') : [this.redis];
    }
}

async function* scanKeys(node: RedisClientLike, pattern: string): AsyncGenerator<string[]> {
    let cursor = '0';
    do {
        const [next, keys] = await node.scan(cursor, 'MATCH', pattern, 'COUNT', SCAN_BATCH);
        cursor = next;
        yield keys;
    } while (cursor !== '0');
}
