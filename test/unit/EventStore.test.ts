import {afterEach, describe, expect, it, vi} from 'vitest';
import {
    type CacheConfig,
    type CreateEventInput,
    createEventStore,
    type EventProjection,
    EventStore,
    type ICacheService,
    MemoryCacheService,
    NoOpCacheService,
    RedisCacheService,
    type RedisClientLike,
} from '../../src/index.js';
import {
    type Capabilities,
    FakeDatabase,
    FakeEventRepository,
    FakeSequenceRepository,
    FakeSnapshotRepository,
    SharedCache,
} from '../support/fakes.js';

const ORDER = { id: 'order-1', type: 'order' };

function event(type: string, aggregateId = ORDER.id, aggregateType = ORDER.type): CreateEventInput {
    return { type, aggregate_id: aggregateId, aggregate_type: aggregateType, created_by: 'user-1', payload: { type } };
}

interface SetupOptions {
    db?: FakeDatabase;
    capabilities?: Capabilities;
    snapshotCapabilities?: { batch?: boolean; after?: boolean };
    cacheService?: ICacheService;
    cache?: CacheConfig;
}

function setup(options: SetupOptions = {}) {
    const db = options.db ?? new FakeDatabase();
    const store = new EventStore({
        eventRepository: new FakeEventRepository(db, options.capabilities),
        sequenceRepository: new FakeSequenceRepository(db),
        snapshotRepository: new FakeSnapshotRepository(db, options.snapshotCapabilities),
        cacheService: options.cacheService ?? new MemoryCacheService(),
        cache: options.cache,
    });
    return { db, store };
}

async function appendMany(store: EventStore, count: number, aggregateId = ORDER.id) {
    await store.appendEvents(Array.from({ length: count }, (_, i) => event(`E${i + 1}`, aggregateId)));
}

const types = (events: Array<{ type: string }>) => events.map(e => e.type);

// Collects event types; mutates its state in place on purpose
const collector: EventProjection<{ seen: string[] }> = {
    get initialState() {
        return { seen: [] };
    },
    applyEvent: (state, e) => {
        state.seen.push(e.type);
        return state;
    },
};

afterEach(() => {
    vi.useRealTimers();
});

describe('appending', () => {
    it('uses the atomic database function when available', async () => {
        const { db, store } = setup();

        const saved = await store.appendEvent(event('Created'));

        expect(saved.sequence_number).toBe(1);
        expect(db.calls).toEqual(['appendEvents']);
    });

    it('falls back to reserving a sequence number and saving', async () => {
        const { db, store } = setup({ capabilities: { atomicAppend: false } });

        await store.appendEvent(event('Created'));
        const saved = await store.appendEvent(event('Paid'));

        expect(saved.sequence_number).toBe(2);
        expect(db.calls).toEqual(['getNextSequence', 'saveEvent', 'getNextSequence', 'saveEvent']);
    });

    it('numbers batches per aggregate, also for types containing ":" and repeated objects', async () => {
        const { store } = setup({ capabilities: { atomicAppend: false } });
        const shared = event('Twice', 'a', 'billing:invoice');

        const saved = await store.appendEvents([
            event('A1', 'a', 'billing:invoice'),
            event('B1', 'b', 'billing:invoice'),
            shared,
            shared,
        ]);

        expect(saved.map(e => `${e.aggregate_id}#${e.sequence_number}`)).toEqual(['a#1', 'b#1', 'a#2', 'a#3']);
    });

    it('returns an empty array for an empty batch', async () => {
        const { db, store } = setup();
        expect(await store.appendEvents([])).toEqual([]);
        expect(db.calls).toEqual([]);
    });
});

describe('reading with the in-memory cache (default: always consistent)', () => {
    it('loads the stream once, then only asks for newer events', async () => {
        const { db, store } = setup();
        await appendMany(store, 3);
        db.resetCalls();

        expect(types(await store.getAggregateEvents(ORDER.id, ORDER.type))).toEqual(['E1', 'E2', 'E3']);
        expect(types(await store.getAggregateEvents(ORDER.id, ORDER.type))).toEqual(['E1', 'E2', 'E3']);

        // Own appends are written through, so even the first read only checks for newer events
        expect(db.calls).toEqual(['findEvents(4..)', 'findEvents(4..)']);
    });

    it('sees events appended by another instance immediately', async () => {
        const db = new FakeDatabase();
        const a = setup({ db }).store;
        const b = setup({ db }).store;

        await appendMany(a, 2);
        expect(types(await b.getAggregateEvents(ORDER.id, ORDER.type))).toEqual(['E1', 'E2']);

        await a.appendEvent(event('E3'));
        db.resetCalls();

        expect(types(await b.getAggregateEvents(ORDER.id, ORDER.type))).toEqual(['E1', 'E2', 'E3']);
        expect(db.calls).toEqual(['findEvents(3..)']);
    });

    it('serves reads without database calls within maxStalenessMs', async () => {
        vi.useFakeTimers();
        const db = new FakeDatabase();
        const a = setup({ db, cache: { maxStalenessMs: 5_000 } }).store;
        const b = setup({ db, cache: { maxStalenessMs: 5_000 } }).store;

        await appendMany(a, 2);
        await b.getAggregateEvents(ORDER.id, ORDER.type);
        await a.appendEvent(event('E3'));
        db.resetCalls();

        expect(types(await b.getAggregateEvents(ORDER.id, ORDER.type))).toEqual(['E1', 'E2']);
        expect(db.calls).toEqual([]);

        vi.advanceTimersByTime(5_001);
        expect(types(await b.getAggregateEvents(ORDER.id, ORDER.type))).toEqual(['E1', 'E2', 'E3']);
        expect(db.calls).toEqual(['findEvents(3..)']);
    });

    it('keeps a single instance consistent without database reads when trusting the cache', async () => {
        const { db, store } = setup({ cache: { maxStalenessMs: Infinity } });

        await store.getAggregateEvents(ORDER.id, ORDER.type);
        await appendMany(store, 2);
        db.resetCalls();

        expect(types(await store.getAggregateEvents(ORDER.id, ORDER.type))).toEqual(['E1', 'E2']);
        expect(db.calls).toEqual([]);
    });

    it('returns results that can be mutated without affecting the cache', async () => {
        const { store } = setup();
        await appendMany(store, 2);

        const first = await store.getAggregateEvents(ORDER.id, ORDER.type);
        first[0].payload.type = 'changed';
        first.pop();

        const second = await store.getAggregateEvents(ORDER.id, ORDER.type);
        expect(types(second)).toEqual(['E1', 'E2']);
        expect(second[0].payload.type).toBe('E1');
    });

    it('shares one database call between concurrent identical reads', async () => {
        const { db, store } = setup();
        await appendMany(store, 3);
        await store.clearCache();
        db.resetCalls();

        const results = await Promise.all(Array.from({ length: 10 }, () => store.getAggregateEvents(ORDER.id, ORDER.type)));

        expect(db.calls).toEqual(['loadStream(1..)']);
        results[0][0].type = 'changed';
        expect(results.slice(1).every(r => r[0].type === 'E1')).toBe(true);
    });

    it('loads cold streams with plain queries without the database function', async () => {
        const { db, store } = setup({ capabilities: { loadStream: false } });
        await appendMany(store, 3);
        await store.clearCache();
        db.resetCalls();

        expect(types(await store.getAggregateEvents(ORDER.id, ORDER.type))).toEqual(['E1', 'E2', 'E3']);
        expect(db.calls).toEqual(['findEvents(1..)']);
    });

    it('serves fromSequence reads from the cached stream', async () => {
        const { db, store } = setup();
        await appendMany(store, 5);
        await store.getAggregateEvents(ORDER.id, ORDER.type);
        db.resetCalls();

        expect(types(await store.getAggregateEvents(ORDER.id, ORDER.type, 4))).toEqual(['E4', 'E5']);
        expect(db.calls).toEqual(['findEvents(6..)']);
    });

    it('loads only the missing prefix when a read needs earlier events than cached', async () => {
        const { db, store } = setup();
        await appendMany(store, 6);
        await store.createSnapshot({ aggregate_id: ORDER.id, aggregate_type: ORDER.type, sequence_number: 4, state: { seen: ['E1', 'E2', 'E3', 'E4'] } });
        await store.clearCache();
        await store.replayEvents(ORDER.id, ORDER.type, collector); // caches events 5..6
        db.resetCalls();

        expect(types(await store.getAggregateEvents(ORDER.id, ORDER.type))).toEqual(['E1', 'E2', 'E3', 'E4', 'E5', 'E6']);
        expect(db.calls.sort()).toEqual(['findEvents(7..)', 'loadStream(1..4)']);
    });

    it('does not let a read that started before an append overwrite the newer cache entry', async () => {
        const db = new FakeDatabase();
        const eventRepository = new FakeEventRepository(db);
        const store = new EventStore({
            eventRepository,
            sequenceRepository: new FakeSequenceRepository(db),
            snapshotRepository: new FakeSnapshotRepository(db),
            cacheService: new MemoryCacheService(),
            cache: { maxStalenessMs: Infinity },
        });
        await appendMany(store, 1);
        await store.clearCache();

        // Hold the first read until the append has completed
        let release!: () => void;
        const gate = new Promise<void>(resolve => (release = resolve));
        const findEvents = eventRepository.findEvents.bind(eventRepository);
        eventRepository.findEvents = async options => {
            const result = await findEvents(options);
            await gate;
            return result;
        };

        const slowRead = store.getAggregateEvents(ORDER.id, ORDER.type);
        await new Promise(resolve => setTimeout(resolve, 0));
        await store.appendEvent(event('E2'));
        release();
        expect(types(await slowRead)).toEqual(['E1']);

        eventRepository.findEvents = findEvents;
        expect(types(await store.getAggregateEvents(ORDER.id, ORDER.type))).toEqual(['E1', 'E2']);
    });
});

describe('replay', () => {
    async function withSnapshot(snapshotAt: number, total: number) {
        const db = new FakeDatabase();
        const writer = setup({ db }).store;
        await appendMany(writer, total);
        const state = await writer.getStateAtSequence(ORDER.id, ORDER.type, collector, snapshotAt);
        await writer.createSnapshot({ aggregate_id: ORDER.id, aggregate_type: ORDER.type, sequence_number: snapshotAt, state });
        db.resetCalls();
        return db;
    }

    it('loads snapshot and following events in one call when cold', async () => {
        const db = await withSnapshot(3, 5);
        const { store } = setup({ db });

        const state = await store.replayEvents(ORDER.id, ORDER.type, collector);

        expect(state.seen).toEqual(['E1', 'E2', 'E3', 'E4', 'E5']);
        expect(db.calls).toEqual(['loadStream']);
    });

    it('needs two calls when cold without the database function', async () => {
        const db = await withSnapshot(3, 5);
        const { store } = setup({ db, capabilities: { loadStream: false } });

        const state = await store.replayEvents(ORDER.id, ORDER.type, collector);

        expect(state.seen).toEqual(['E1', 'E2', 'E3', 'E4', 'E5']);
        expect(db.calls).toEqual(['findLatestSnapshot', 'findEvents(4..)']);
    });

    it('only asks for newer events when warm', async () => {
        const db = await withSnapshot(3, 5);
        const { store } = setup({ db });
        await store.replayEvents(ORDER.id, ORDER.type, collector);
        await setup({ db }).store.appendEvent(event('E6'));
        db.resetCalls();

        const state = await store.replayEvents(ORDER.id, ORDER.type, collector);

        expect(state.seen).toEqual(['E1', 'E2', 'E3', 'E4', 'E5', 'E6']);
        expect(db.calls).toEqual(['findEvents(6..)']);
    });

    it('does not corrupt cached data with projections that mutate state', async () => {
        const db = await withSnapshot(2, 3);
        const { store } = setup({ db });

        const first = await store.replayEvents(ORDER.id, ORDER.type, collector);
        const second = await store.replayEvents(ORDER.id, ORDER.type, collector);

        expect(first.seen).toEqual(['E1', 'E2', 'E3']);
        expect(second.seen).toEqual(['E1', 'E2', 'E3']);
    });

    it('uses an older snapshot for a point in time before the latest one', async () => {
        const db = await withSnapshot(3, 8);
        const writer = setup({ db }).store;
        await writer.createSnapshot({ aggregate_id: ORDER.id, aggregate_type: ORDER.type, sequence_number: 6, state: { seen: ['snapshot-6'] } });

        for (const store of [setup({ db }).store, setup({ db, capabilities: { loadStream: false } }).store, writer]) {
            const state = await store.getStateAtSequence(ORDER.id, ORDER.type, collector, 4);
            expect(state.seen).toEqual(['E1', 'E2', 'E3', 'E4']);
        }
    });

    it('replays from an explicit sequence without snapshot', async () => {
        const db = await withSnapshot(3, 5);
        const { store } = setup({ db });

        const state = await store.replayEvents(ORDER.id, ORDER.type, collector, { from_sequence: 2, to_sequence: 4 });

        expect(state.seen).toEqual(['E2', 'E3', 'E4']);
    });
});

describe('snapshots', () => {
    it('rebuildWithSnapshots saves all snapshots in one call without duplicating the last one', async () => {
        const { db, store } = setup();
        await appendMany(store, 100);
        db.resetCalls();

        const state = await store.rebuildWithSnapshots(ORDER.id, ORDER.type, collector, 50);

        expect(state.seen).toHaveLength(100);
        expect(db.calls.filter(c => c.startsWith('save'))).toEqual(['saveSnapshots']);
        expect(db.snapshots.map(s => [s.sequence_number, s.state.seen.length])).toEqual([[50, 50], [100, 100]]);
    });

    it('rebuildWithSnapshots falls back to saving snapshots one by one', async () => {
        const { db, store } = setup({ snapshotCapabilities: { batch: false } });
        await appendMany(store, 5);
        db.resetCalls();

        await store.rebuildWithSnapshots(ORDER.id, ORDER.type, collector, 2);

        expect(db.calls.filter(c => c.startsWith('save'))).toEqual(['saveSnapshot', 'saveSnapshot', 'saveSnapshot']);
        expect(db.snapshots.map(s => s.sequence_number)).toEqual([2, 4, 5]);
    });

    it('getLatestSnapshot only transfers a snapshot when there is a newer one', async () => {
        const db = new FakeDatabase();
        const reader = setup({ db }).store;
        const writer = setup({ db }).store;
        await writer.createSnapshot({ aggregate_id: ORDER.id, aggregate_type: ORDER.type, sequence_number: 1, state: { v: 1 } });

        expect((await reader.getLatestSnapshot(ORDER.id, ORDER.type))?.state).toEqual({ v: 1 });
        expect((await reader.getLatestSnapshot(ORDER.id, ORDER.type))?.state).toEqual({ v: 1 });
        await writer.createSnapshot({ aggregate_id: ORDER.id, aggregate_type: ORDER.type, sequence_number: 2, state: { v: 2 } });
        expect((await reader.getLatestSnapshot(ORDER.id, ORDER.type))?.state).toEqual({ v: 2 });

        expect(db.calls.filter(c => c.startsWith('find'))).toEqual([
            'findLatestSnapshot',
            'findLatestSnapshotAfter',
            'findLatestSnapshotAfter',
        ]);
    });

    it('caches the absence of snapshots', async () => {
        const { db, store } = setup({ cache: { maxStalenessMs: Infinity } });
        await appendMany(store, 2);
        await store.replayEvents(ORDER.id, ORDER.type, collector);
        db.resetCalls();

        await store.replayEvents(ORDER.id, ORDER.type, collector);

        expect(db.calls).toEqual([]);
    });

    it('pruneSnapshots drops the cached latest snapshot', async () => {
        const { store } = setup();
        await store.createSnapshot({ aggregate_id: ORDER.id, aggregate_type: ORDER.type, sequence_number: 1, state: {} });

        expect(await store.pruneSnapshots(ORDER.id, ORDER.type, 0)).toBe(1);
        expect(await store.getLatestSnapshot(ORDER.id, ORDER.type)).toBeNull();
    });
});

describe('statistics and validation', () => {
    it('computes stats in the database when the stream is not cached', async () => {
        const db = new FakeDatabase();
        await appendMany(setup({ db }).store, 3);
        const { store } = setup({ db });
        db.resetCalls();

        const stats = await store.getAggregateStats(ORDER.id, ORDER.type);

        expect(stats.totalEvents).toBe(3);
        expect(stats.lastEvent?.type).toBe('E3');
        expect([...stats.eventTypes]).toEqual([['E1', 1], ['E2', 1], ['E3', 1]]);
        expect(db.calls).toEqual(['getAggregateStats']);
    });

    it('computes stats from the cached stream when available', async () => {
        const { db, store } = setup();
        await appendMany(store, 3);
        await store.getAggregateEvents(ORDER.id, ORDER.type);
        db.resetCalls();

        expect((await store.getAggregateStats(ORDER.id, ORDER.type)).totalEvents).toBe(3);
        expect(db.calls).toEqual(['findEvents(4..)']);
    });

    it('falls back to loading the stream without the database function', async () => {
        const { db, store } = setup({ capabilities: { stats: false } });
        await appendMany(store, 2);
        await store.clearCache();
        db.resetCalls();

        expect((await store.getAggregateStats(ORDER.id, ORDER.type)).totalEvents).toBe(2);
        expect(db.calls).toEqual(['loadStream(1..)']);
    });

    it('reports sequence gaps', async () => {
        const { db, store } = setup();
        await appendMany(store, 3);
        db.events.splice(1, 1);
        await store.clearCache();

        expect(await store.validateEventStream(ORDER.id, ORDER.type)).toEqual({
            valid: false,
            issues: ['Sequence gap: expected 2, got 3'],
        });
    });
});

describe('shared cache (Redis semantics)', () => {
    function sharedSetup(db: FakeDatabase, cache: SharedCache) {
        return setup({ db, cacheService: cache }).store;
    }

    it('trusts the cache for plain reads and invalidates it on append', async () => {
        const db = new FakeDatabase();
        const cache = new SharedCache();
        const a = sharedSetup(db, cache);
        const b = sharedSetup(db, cache);
        await appendMany(a, 2);
        db.resetCalls();

        await a.getAggregateEvents(ORDER.id, ORDER.type);
        await b.getAggregateEvents(ORDER.id, ORDER.type);
        expect(db.calls).toEqual(['loadStream(1..)']);

        await a.appendEvent(event('E3'));
        db.resetCalls();
        expect(types(await b.getAggregateEvents(ORDER.id, ORDER.type))).toEqual(['E1', 'E2', 'E3']);
        expect(db.calls).toEqual(['loadStream(1..)']);
    });

    it('always checks for newer events when replaying', async () => {
        const db = new FakeDatabase();
        const store = sharedSetup(db, new SharedCache());
        await appendMany(store, 2);
        await store.replayEvents(ORDER.id, ORDER.type, collector);

        // Written by a writer that does not invalidate the cache
        db.insertEvent(event('E3'), 3);
        db.resetCalls();

        expect((await store.replayEvents(ORDER.id, ORDER.type, collector)).seen).toEqual(['E1', 'E2', 'E3']);
        expect(db.calls).toEqual(['findEvents(3..)']);
    });

    it('caches sequence numbers and stats until the next append', async () => {
        const db = new FakeDatabase();
        const store = sharedSetup(db, new SharedCache());
        await appendMany(store, 2);
        db.resetCalls();

        expect(await store.getCurrentSequenceNumber(ORDER.id, ORDER.type)).toBe(2);
        expect(await store.getCurrentSequenceNumber(ORDER.id, ORDER.type)).toBe(2);
        expect((await store.getAggregateStats(ORDER.id, ORDER.type)).totalEvents).toBe(2);
        expect((await store.getAggregateStats(ORDER.id, ORDER.type)).totalEvents).toBe(2);
        expect(db.calls).toEqual(['getCurrentSequence', 'getAggregateStats']);

        await store.appendEvent(event('E3'));
        expect(await store.getCurrentSequenceNumber(ORDER.id, ORDER.type)).toBe(3);
        expect((await store.getAggregateStats(ORDER.id, ORDER.type)).totalEvents).toBe(3);
    });
});

describe('replayEventStream', () => {
    it('starts a single aggregate stream at from_sequence', async () => {
        const { store } = setup();
        await appendMany(store, 5);
        const batches: string[][] = [];

        await store.replayEventStream(
            { aggregate_id: ORDER.id, aggregate_type: ORDER.type, from_sequence: 3 },
            async events => { batches.push(types(events)); },
            2
        );

        expect(batches).toEqual([['E3', 'E4'], ['E5']]);
    });

    it('delivers every event of multi-aggregate streams exactly once', async () => {
        const { db, store } = setup();
        for (let round = 1; round <= 5; round++) {
            for (const id of ['a', 'b', 'c']) await store.appendEvent(event(`${id}${round}`, id));
        }
        db.resetCalls();
        const seen: string[] = [];

        await store.replayEventStream({ aggregate_type: ORDER.type }, async events => { seen.push(...types(events)); }, 4);

        expect(seen).toHaveLength(15);
        expect(new Set(seen).size).toBe(15);
        expect(seen.slice(0, 3)).toEqual(['a1', 'b1', 'c1']);
        expect(db.calls).toEqual(['findEventsPage(0)', 'findEventsPage(4)', 'findEventsPage(8)', 'findEventsPage(12)']);
    });
});

describe('cache configuration', () => {
    it('does not cache with enabled: false but still shares concurrent reads', async () => {
        const { db, store } = setup({ cache: { enabled: false } });
        await appendMany(store, 2);
        db.resetCalls();

        await store.getAggregateEvents(ORDER.id, ORDER.type);
        await store.getAggregateEvents(ORDER.id, ORDER.type);
        await Promise.all([store.getAggregateEvents(ORDER.id, ORDER.type), store.getAggregateEvents(ORDER.id, ORDER.type)]);

        expect(db.calls).toEqual(['loadStream(1..)', 'loadStream(1..)', 'loadStream(1..)']);
    });

    it('works without caching (NoOpCacheService)', async () => {
        const { store } = setup({ cacheService: new NoOpCacheService() });
        await appendMany(store, 2);

        expect((await store.replayEvents(ORDER.id, ORDER.type, collector)).seen).toEqual(['E1', 'E2']);
        expect(await store.getCacheStats()).toEqual({ enabled: false, type: 'NoOpCacheService' });
    });

    it('reports in-memory cache usage', async () => {
        const { store } = setup();
        await appendMany(store, 2);
        await store.warmupCache(ORDER.id, ORDER.type);

        const stats = await store.getCacheStats();
        expect(stats.enabled).toBe(true);
        expect(stats.type).toBe('MemoryCacheService');
        expect(stats.info?.keys).toBeGreaterThan(0);
    });

    it('clearAggregateCache forces a reload', async () => {
        const { db, store } = setup();
        await appendMany(store, 2);
        await store.getAggregateEvents(ORDER.id, ORDER.type);
        await store.clearAggregateCache(ORDER.id, ORDER.type);
        db.resetCalls();

        await store.getAggregateEvents(ORDER.id, ORDER.type);
        expect(db.calls).toEqual(['loadStream(1..)']);
    });
});

describe('createEventStore', () => {
    const supabase = {} as never;
    const cacheOf = (store: EventStore) => store.getCacheStats().then(stats => stats.type);

    it('uses the in-memory cache without Redis', async () => {
        expect(await cacheOf(createEventStore({ supabase }))).toBe('MemoryCacheService');
    });

    it('uses Redis when a client is given', async () => {
        const redis = { get: vi.fn(), set: vi.fn(), unlink: vi.fn(), scan: vi.fn().mockResolvedValue(['0', []]) } as unknown as RedisClientLike;
        expect(await cacheOf(createEventStore({ supabase, redis }))).toBe(RedisCacheService.name);
    });

    it('disables caching with enabled: false', async () => {
        expect(await cacheOf(createEventStore({ supabase, cache: { enabled: false } }))).toBe('NoOpCacheService');
    });
});
