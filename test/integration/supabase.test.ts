import {randomUUID} from 'node:crypto';
import type {SupabaseClient} from '@supabase/supabase-js';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {
    type CreateEventInput,
    createEventStore,
    type EventProjection,
    type EventStoreBuilderConfig,
    SupabaseEventRepository,
    SupabaseSnapshotRepository,
} from '../../src/index.js';
import {integrationEnv, RestProxy, serviceRoleClient} from '../support/postgrest.js';

const env = integrationEnv();
const USER = randomUUID();

const event = (aggregateId: string, type: string, aggregateType = 'order'): CreateEventInput => ({
    type,
    aggregate_id: aggregateId,
    aggregate_type: aggregateType,
    created_by: USER,
    payload: { type },
});

const counter: EventProjection<{ count: number; last?: string }> = {
    initialState: { count: 0 },
    applyEvent: (state, e) => ({ count: state.count + 1, last: e.type }),
};

describe.skipIf(!env)('Supabase adapters against PostgREST', () => {
    const proxies = { functions: new RestProxy(env?.url ?? ''), legacy: new RestProxy(env?.legacyUrl ?? '') };
    const clients = {} as Record<keyof typeof proxies, SupabaseClient>;

    beforeAll(async () => {
        for (const name of ['functions', 'legacy'] as const) {
            clients[name] = serviceRoleClient(await proxies[name].start(), env!.jwtSecret);
        }
    });

    afterAll(async () => {
        await Promise.all(Object.values(proxies).map(proxy => proxy.stop()));
    });

    beforeEach(() => {
        proxies.functions.reset();
        proxies.legacy.reset();
    });

    const store = (name: keyof typeof proxies, config: Partial<EventStoreBuilderConfig> = {}) =>
        createEventStore({ supabase: clients[name], ...config });

    describe.each(['functions', 'legacy'] as const)('database %s', name => {
        it('appends, reads and replays', async () => {
            const id = randomUUID();
            const es = store(name);

            await es.appendEvent(event(id, 'Created'));
            await es.appendEvents([event(id, 'Paid'), event(id, 'Shipped')]);

            const events = await store(name).getAggregateEvents(id, 'order');
            expect(events.map(e => [e.sequence_number, e.type])).toEqual([[1, 'Created'], [2, 'Paid'], [3, 'Shipped']]);
            expect(events[0]).toMatchObject({ aggregate_id: id, created_by: USER, version: 1, payload: { type: 'Created' }, metadata: {} });
            expect(await store(name).replayEvents(id, 'order', counter)).toEqual({ count: 3, last: 'Shipped' });
            expect(await es.validateEventStream(id, 'order')).toEqual({ valid: true, issues: [] });
        });

        it('reads streams longer than PostgREST max-rows completely', async () => {
            const id = randomUUID();
            const es = store(name);
            for (let batch = 0; batch < 5; batch++) {
                await es.appendEvents(Array.from({ length: 500 }, (_, i) => event(id, `E${batch * 500 + i + 1}`)));
            }

            const events = await store(name).getAggregateEvents(id, 'order');
            expect(events).toHaveLength(2500);
            expect(events.at(-1)?.sequence_number).toBe(2500);

            expect((await store(name).queryEvents({ aggregate_id: id, aggregate_type: 'order', limit: 1500 }))).toHaveLength(1500);
            expect((await store(name).replayEvents(id, 'order', counter)).count).toBe(2500);
            expect((await store(name).getAggregateStats(id, 'order')).totalEvents).toBe(2500);
        });

        it('replays from snapshots and to earlier points in time', async () => {
            const id = randomUUID();
            const es = store(name);
            await es.appendEvents(Array.from({ length: 10 }, (_, i) => event(id, `E${i + 1}`)));
            await es.createSnapshot({ aggregate_id: id, aggregate_type: 'order', sequence_number: 4, state: { count: 4, last: 'E4' } });
            await es.createSnapshot({ aggregate_id: id, aggregate_type: 'order', sequence_number: 8, state: { count: 8, last: 'E8' } });

            expect(await store(name).replayEvents(id, 'order', counter)).toEqual({ count: 10, last: 'E10' });
            expect(await store(name).getStateAtSequence(id, 'order', counter, 6)).toEqual({ count: 6, last: 'E6' });
            expect(await store(name).getStateAtSequence(id, 'order', counter, 2)).toEqual({ count: 2, last: 'E2' });
        });

        it('computes statistics', async () => {
            const id = randomUUID();
            await store(name).appendEvents([event(id, 'A'), event(id, 'B'), event(id, 'A')]);

            const stats = await store(name).getAggregateStats(id, 'order');
            expect(stats.totalEvents).toBe(3);
            expect(stats.firstEvent?.sequence_number).toBe(1);
            expect(stats.lastEvent?.sequence_number).toBe(3);
            expect([...stats.eventTypes]).toEqual([['A', 2], ['B', 1]]);
        });

        it('rebuilds with snapshots and prunes old ones', async () => {
            const id = randomUUID();
            const es = store(name);
            await es.appendEvents(Array.from({ length: 7 }, (_, i) => event(id, `E${i + 1}`)));

            expect(await es.rebuildWithSnapshots(id, 'order', counter, 3)).toEqual({ count: 7, last: 'E7' });
            expect((await es.getLatestSnapshot(id, 'order'))?.sequence_number).toBe(7);
            expect(await es.pruneSnapshots(id, 'order', 1)).toBe(2);
            expect((await es.getSnapshotAtSequence(id, 'order', 6))).toBeNull();
            expect((await es.getLatestSnapshot(id, 'order'))?.sequence_number).toBe(7);
        });

        it('pages streams across aggregates without losing events', async () => {
            const type = `stream-${randomUUID()}`;
            const ids = [randomUUID(), randomUUID(), randomUUID()];
            const es = store(name);
            for (let round = 1; round <= 4; round++) {
                await es.appendEvents(ids.map(id => event(id, `R${round}`, type)));
            }

            const seen: string[] = [];
            await es.replayEventStream({ aggregate_type: type }, async events => {
                seen.push(...events.map(e => `${e.aggregate_id}#${e.sequence_number}`));
            }, 5);

            expect(seen).toHaveLength(12);
            expect(new Set(seen).size).toBe(12);
        });

        it('returns the most recent events of a type first', async () => {
            const type = `Typed-${randomUUID()}`;
            const es = store(name);
            await es.appendEvent(event(randomUUID(), type));
            const second = await es.appendEvent(event(randomUUID(), type));

            const latest = await es.getEventsByType(type, 1);
            expect(latest.map(e => e.id)).toEqual([second.id]);
        });
    });

    it('appends in one request and loads a cold aggregate in one request with the database functions', async () => {
        const id = randomUUID();
        await store('functions').appendEvent(event(id, 'Warmup'));
        proxies.functions.reset();

        await store('functions').appendEvent(event(id, 'Created'));
        expect(proxies.functions.reset()).toEqual(['POST /rpc/es_append_events']);

        await store('functions').replayEvents(id, 'order', counter);
        expect(proxies.functions.reset()).toEqual(['POST /rpc/es_load_stream']);
    });

    it('falls back without the database functions and remembers that they are missing', async () => {
        const id = randomUUID();
        const es = store('legacy');

        await es.appendEvent(event(id, 'Created'));
        expect(proxies.legacy.reset()).toEqual([
            'POST /rpc/es_append_events',
            'GET /aggregate_sequences',
            'POST /aggregate_sequences',
            'POST /events',
        ]);

        await es.appendEvent(event(id, 'Paid'));
        expect(proxies.legacy.reset()).toEqual(['GET /aggregate_sequences', 'POST /aggregate_sequences', 'POST /events']);
    });

    it('fails loudly when the database functions are required but missing', async () => {
        await expect(store('legacy', { rpc: true }).appendEvent(event(randomUUID(), 'Created')))
            .rejects.toThrow(/es_append_events is not installed/);
    });

    it('allocates unique, gap-free sequence numbers under concurrent appends', async () => {
        const id = randomUUID();
        const writers = Array.from({ length: 5 }, () => store('functions'));

        await Promise.all(Array.from({ length: 40 }, (_, i) => writers[i % writers.length].appendEvent(event(id, `E${i}`))));

        const sequences = (await store('functions').getAggregateEvents(id, 'order')).map(e => e.sequence_number);
        expect(sequences).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    });

    it('stores snapshots in batches and finds newer ones', async () => {
        const id = randomUUID();
        const snapshots = new SupabaseSnapshotRepository(clients.functions);
        const saved = await snapshots.saveSnapshots([1, 2, 3].map(n => ({ aggregate_id: id, aggregate_type: 'order', sequence_number: n, state: { n } })));

        expect(saved.map(s => s.sequence_number)).toEqual([1, 2, 3]);
        expect((await snapshots.findLatestSnapshotAfter(id, 'order', 1))?.sequence_number).toBe(3);
        expect(await snapshots.findLatestSnapshotAfter(id, 'order', 3)).toBeNull();
        expect(await snapshots.deleteOldSnapshots(id, 'order', 0)).toBe(3);
    });

    it('reports errors of the database function', async () => {
        const repository = new SupabaseEventRepository(clients.functions);
        await expect(repository.appendEvents([{ ...event('not-a-uuid', 'X') }])).rejects.toThrow(/invalid input syntax for type uuid/);
    });
});
