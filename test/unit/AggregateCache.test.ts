import {describe, expect, it} from 'vitest';
import {AggregateCache, mergeEntries, sliceStream, type StreamEntry} from '../../src/app/AggregateCache.js';
import {type EventRecord, MemoryCacheService, NoOpCacheService, RedisCacheService, type RedisClientLike} from '../../src/index.js';

const event = (sequence: number): EventRecord => ({
    id: `e${sequence}`, type: 'T', aggregate_id: 'a', aggregate_type: 't', sequence_number: sequence,
    version: 1, payload: {}, metadata: {}, created_at: '', created_by: 'u',
});
const entry = (from: number, to: number): StreamEntry => ({
    from, to, events: Array.from({ length: to - from + 1 }, (_, i) => event(from + i)),
});
const sequences = (e: StreamEntry | EventRecord[]) => (Array.isArray(e) ? e : e.events).map(x => x.sequence_number);

describe('sliceStream', () => {
    it('returns the events within the range', () => {
        expect(sequences(sliceStream(entry(1, 10), 3, 5))).toEqual([3, 4, 5]);
        expect(sequences(sliceStream(entry(1, 10), 8))).toEqual([8, 9, 10]);
        expect(sequences(sliceStream(entry(5, 10), 1, 6))).toEqual([5, 6]);
        expect(sliceStream(entry(1, 10), 11)).toEqual([]);
    });

    it('handles gaps in sequence numbers', () => {
        const gappy = { from: 1, to: 9, events: [event(1), event(4), event(9)] };
        expect(sequences(sliceStream(gappy, 2, 8))).toEqual([4]);
    });
});

describe('mergeEntries', () => {
    it('joins overlapping and adjacent entries', () => {
        expect(sequences(mergeEntries(entry(1, 5), entry(4, 8)))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
        expect(sequences(mergeEntries(entry(6, 8), entry(1, 5)))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
        expect(mergeEntries(entry(6, 8), entry(1, 5))).toMatchObject({ from: 1, to: 8 });
    });

    it('keeps the outer entry when one contains the other', () => {
        expect(sequences(mergeEntries(entry(1, 10), entry(3, 4)))).toEqual(sequences(entry(1, 10)));
        expect(mergeEntries(entry(3, 4), entry(1, 10))).toMatchObject({ from: 1, to: 10 });
    });

    it('keeps the entry reaching further when there is a gap', () => {
        expect(mergeEntries(entry(1, 3), entry(6, 8))).toMatchObject({ from: 6, to: 8 });
        expect(mergeEntries(entry(6, 8), entry(1, 3))).toMatchObject({ from: 6, to: 8 });
    });

    it('supports empty entries', () => {
        expect(mergeEntries({ from: 1, to: 0, events: [] }, entry(1, 2))).toMatchObject({ from: 1, to: 2 });
        expect(mergeEntries(entry(1, 3), { from: 4, to: 3, events: [] })).toMatchObject({ from: 1, to: 3 });
    });
});

describe('AggregateCache configuration', () => {
    const redis = {} as RedisClientLike;

    it('always checks the database with the in-memory cache by default', () => {
        const cache = new AggregateCache(new MemoryCacheService());
        expect(cache.isFresh('k', 'read')).toBe(false);
        expect(cache.isFresh('k', 'replay')).toBe(false);
        expect(cache.cachesDerivedValues).toBe(false);
    });

    it('trusts shared caches for plain reads but not for replays by default', () => {
        const cache = new AggregateCache(new RedisCacheService(redis));
        expect(cache.isFresh('k', 'read')).toBe(true);
        expect(cache.isFresh('k', 'replay')).toBe(false);
        expect(cache.cachesDerivedValues).toBe(true);
    });

    it('applies an explicit staleness window to all reads', () => {
        const cache = new AggregateCache(new RedisCacheService(redis), { maxStalenessMs: 1000 });
        expect(cache.isFresh('k', 'read')).toBe(false);
        cache.markSynced('k');
        expect(cache.isFresh('k', 'read')).toBe(true);
        expect(cache.isFresh('k', 'replay')).toBe(true);
    });

    it('uses the key prefix and TTLs of a RedisCacheService built without EventStore config', () => {
        const cache = new AggregateCache(new RedisCacheService(redis, { keyPrefix: 'app:' }));
        expect(cache.streamKey({ aggregateId: 'id', aggregateType: 'order' })).toBe('app:agg:order:id:stream');
    });

    it('escapes separators in aggregate ids and types', () => {
        const cache = new AggregateCache(new MemoryCacheService());
        const a = cache.streamKey({ aggregateId: 'b:c', aggregateType: 'a' });
        const b = cache.streamKey({ aggregateId: 'c', aggregateType: 'a:b' });
        expect(a).not.toBe(b);
    });

    it('is disabled for NoOpCacheService and enabled: false', () => {
        expect(new AggregateCache(new NoOpCacheService()).enabled).toBe(false);
        expect(new AggregateCache(new MemoryCacheService(), { enabled: false }).enabled).toBe(false);
    });
});
