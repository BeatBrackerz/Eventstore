/**
 * Minimal subset of the Redis client API used by the event store.
 *
 * `ioredis` clients (`Redis` and `Cluster`) satisfy it structurally, so `ioredis`
 * does not have to be installed unless you actually use Redis.
 */
export interface RedisClientLike {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, secondsToken: 'EX', seconds: number): Promise<unknown>;
    unlink(...keys: string[]): Promise<number>;
    scan(cursor: string, matchToken: 'MATCH', pattern: string, countToken: 'COUNT', count: number): Promise<[cursor: string, keys: string[]]>;
    info?(section: string): Promise<string>;
    /** Present on cluster clients; pattern operations run against every master node. */
    nodes?(role: 'master'): RedisClientLike[];
}

/**
 * Options for the built-in in-memory cache
 */
export interface MemoryCacheOptions {
    maxEntries?: number; // Maximum number of cached entries (default: 10000)
    maxSizeBytes?: number; // Approximate memory budget in bytes (default: 64 MiB)
}

/**
 * Cache configuration options
 */
export interface CacheConfig {
    /** @deprecated Pass the client as `redis` to `createEventStore` instead. Still honoured. */
    redis?: RedisClientLike;
    enabled?: boolean; // Set to false to disable caching entirely (default: true)
    ttl?: {
        events?: number; // TTL for event cache in seconds (default: 3600)
        snapshots?: number; // TTL for snapshot cache in seconds (default: 7200)
        sequences?: number; // TTL for sequence cache in seconds (default: 300)
        aggregateEvents?: number; // TTL for aggregate event lists (default: 1800)
    };
    keyPrefix?: string; // Prefix for all cache keys (default: 'es:')
    /**
     * How old (in ms) cached aggregate data may be before a read asks the database for newer events.
     * Events are immutable, so that check is a small delta query ("events after the cached sequence").
     *
     * - `0`: every read checks. Always consistent, even with several app instances.
     * - `n > 0`: reads within `n` ms after the last check are served without a database round trip.
     * - `Infinity`: trust the cache until this process' writes invalidate it or the TTL expires.
     *
     * Default: `0` for the built-in in-memory cache. For Redis and custom caches plain reads trust
     * the cache (as in previous versions) while replays always check.
     */
    maxStalenessMs?: number;
    memory?: MemoryCacheOptions; // Options for the in-memory cache used when no Redis client is configured
}
