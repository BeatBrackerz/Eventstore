import {ICacheService} from "../ports";

/**
 * Adapter: No-Op Cache Service (for when caching is disabled)
 */
export class NoOpCacheService implements ICacheService {
    async get<T>(): Promise<T | null> { return null; }
    async set<T>(): Promise<void> {}
    async delete(): Promise<void> {}
    async deletePattern(): Promise<void> {}
    async getMultiple<T>(): Promise<Map<string, T>> { return new Map(); }
    async setMultiple<T>(): Promise<void> {}
    cacheKey(...parts: string[]): string { return parts.join(':'); }
    getTTL(): number { return 0; }
}