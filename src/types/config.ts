import {Redis} from "ioredis";

/**
 * Cache configuration options
 */
export interface CacheConfig {
    redis?: Redis;
    enabled?: boolean;
    ttl?: {
        events?: number; // TTL for event cache in seconds (default: 3600)
        snapshots?: number; // TTL for snapshot cache in seconds (default: 7200)
        sequences?: number; // TTL for sequence cache in seconds (default: 300)
        aggregateEvents?: number; // TTL for aggregate event lists (default: 1800)
    };
    keyPrefix?: string; // Prefix for all cache keys (default: 'es:')
}