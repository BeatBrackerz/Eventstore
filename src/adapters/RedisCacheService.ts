import {ICacheService} from "../ports";
import {CacheConfig} from "../domain";
import {Redis} from "ioredis";

/**
 * Adapter: Redis Cache Service
 */
export class RedisCacheService implements ICacheService {
    private readonly ttl: Required<CacheConfig['ttl']>;
    private readonly keyPrefix: string;

    constructor(
        private readonly redis: Redis,
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
        try {
            await this.redis.setex(key, ttl, JSON.stringify(value));
        } catch (err) {
            console.error('Cache write error:', err);
        }
    }

    async delete(key: string): Promise<void> {
        try {
            await this.redis.del(key);
        } catch (err) {
            console.error('Cache delete error:', err);
        }
    }

    async deletePattern(pattern: string): Promise<void> {
        try {
            const keys = await this.redis.keys(pattern);
            if (keys.length > 0) await this.redis.del(...keys);
        } catch (err) {
            console.error('Cache pattern delete error:', err);
        }
    }

    async getMultiple<T>(keys: string[]): Promise<Map<string, T>> {
        if (keys.length === 0) return new Map();

        try {
            const pipeline = this.redis.pipeline();
            keys.forEach(key => pipeline.get(key));
            const results = await pipeline.exec();

            const map = new Map<string, T>();
            results?.forEach((result, index) => {
                if (result && result[1]) {
                    try {
                        map.set(keys[index], JSON.parse(result[1] as string));
                    } catch {}
                }
            });

            return map;
        } catch (err) {
            console.error('Cache multi-read error:', err);
            return new Map();
        }
    }

    async setMultiple<T>(entries: Array<{ key: string; value: T; ttl: number }>): Promise<void> {
        if (entries.length === 0) return;

        try {
            const pipeline = this.redis.pipeline();
            entries.forEach(({ key, value, ttl }) => {
                pipeline.setex(key, ttl, JSON.stringify(value));
            });
            await pipeline.exec();
        } catch (err) {
            console.error('Cache multi-write error:', err);
        }
    }

    cacheKey(...parts: string[]): string {
        return `${this.keyPrefix}${parts.join(':')}`;
    }

    getTTL(type: keyof Required<CacheConfig['ttl']>): number {
        return this.ttl[type];
    }
}
