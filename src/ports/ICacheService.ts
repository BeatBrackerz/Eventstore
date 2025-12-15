/**
 * Port: Cache Service
 * Defines contract for caching
 */
export interface ICacheService {
    get<T>(key: string): Promise<T | null>;
    set<T>(key: string, value: T, ttl: number): Promise<void>;
    delete(key: string): Promise<void>;
    deletePattern(pattern: string): Promise<void>;
    getMultiple<T>(keys: string[]): Promise<Map<string, T>>;
    setMultiple<T>(entries: Array<{ key: string; value: T; ttl: number }>): Promise<void>;
}