import {describe, expect, it} from 'vitest';
import {MemoryCacheService} from '../../src/index.js';

describe('MemoryCacheService', () => {
    it('stores and returns values until their TTL expires', async () => {
        let now = 0;
        const cache = new MemoryCacheService({ now: () => now });

        await cache.set('a', { value: 1 }, 10);
        expect(await cache.get('a')).toEqual({ value: 1 });

        now = 9_999;
        expect(await cache.get('a')).toEqual({ value: 1 });

        now = 10_000;
        expect(await cache.get('a')).toBeNull();
        expect(cache.size).toBe(0);
    });

    it('returns an independent copy on every read', async () => {
        const cache = new MemoryCacheService();
        const value = { list: [1, 2] };
        await cache.set('a', value, 60);

        value.list.push(3);
        const first = await cache.get<{ list: number[] }>('a');
        first!.list.push(4);

        expect(await cache.get('a')).toEqual({ list: [1, 2] });
    });

    it('evicts least recently used entries beyond maxEntries', async () => {
        const cache = new MemoryCacheService({ maxEntries: 2 });
        await cache.set('a', 1, 60);
        await cache.set('b', 2, 60);
        await cache.get('a'); // a is now more recent than b
        await cache.set('c', 3, 60);

        expect(await cache.get('a')).toBe(1);
        expect(await cache.get('b')).toBeNull();
        expect(await cache.get('c')).toBe(3);
    });

    it('evicts entries beyond the memory budget and skips values larger than the budget', async () => {
        const cache = new MemoryCacheService({ maxSizeBytes: 100 });
        await cache.set('a', 'x'.repeat(20), 60); // ~46 bytes
        await cache.set('b', 'y'.repeat(20), 60);
        expect(cache.size).toBe(2);

        await cache.set('c', 'z'.repeat(20), 60);
        expect(await cache.get('a')).toBeNull();
        expect(cache.sizeBytes).toBeLessThanOrEqual(100);

        await cache.set('huge', 'h'.repeat(1000), 60);
        expect(await cache.get('huge')).toBeNull();
    });

    it('does not store values with a TTL of 0 and replaces existing ones', async () => {
        const cache = new MemoryCacheService();
        await cache.set('a', 1, 60);
        await cache.set('a', 2, 0);
        expect(await cache.get('a')).toBeNull();
        expect(cache.sizeBytes).toBe(0);
    });

    it('deletes by key, key list and glob pattern', async () => {
        const cache = new MemoryCacheService();
        for (const key of ['es:agg:1', 'es:agg:2', 'es:seq:1', 'other:1']) await cache.set(key, key, 60);

        await cache.delete('es:seq:1');
        await cache.deleteMany(['es:agg:2']);
        expect([...await cache.getMultiple(['es:agg:1', 'es:agg:2', 'es:seq:1', 'other:1'])].map(([k]) => k))
            .toEqual(['es:agg:1', 'other:1']);

        await cache.deletePattern('es:*');
        expect(await cache.get('es:agg:1')).toBeNull();
        expect(await cache.get('other:1')).toBe('other:1');
    });

    it('treats regex characters in patterns literally', async () => {
        const cache = new MemoryCacheService();
        await cache.set('a.b', 1, 60);
        await cache.set('axb', 2, 60);
        await cache.deletePattern('a.b');
        expect(await cache.get('a.b')).toBeNull();
        expect(await cache.get('axb')).toBe(2);
    });
});
