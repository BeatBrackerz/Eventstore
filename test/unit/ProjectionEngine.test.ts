import {afterEach, describe, expect, it, vi} from 'vitest';
import {
    type CreateEventInput,
    EventStore,
    type EventRecord,
    type IEventPublisher,
    MemoryCacheService,
    MemoryReadModelStore,
    type ProjectionCommit,
    type ProjectionDefinition,
    ProjectionError,
    type ProjectionOptions,
    START_POSITION,
} from '../../src/index.js';
import {type Capabilities, FakeDatabase, FakeEventRepository, FakeSequenceRepository, FakeSnapshotRepository} from '../support/fakes.js';

interface OrderSummary {
    id: string;
    status: string;
    items: number;
    total: number;
}

function event(type: string, aggregateId: string, payload: Record<string, unknown> = {}, aggregateType = 'order'): CreateEventInput {
    return { type, aggregate_id: aggregateId, aggregate_type: aggregateType, created_by: 'user-1', payload };
}

const orderSummaries = (overrides: Partial<ProjectionDefinition> = {}): ProjectionDefinition => ({
    name: 'order-summaries',
    collections: ['order_summaries'],
    handlers: {
        OrderCreated: (e, ctx) => ctx.upsert('order_summaries', { id: e.aggregate_id, status: 'open', items: 0, total: 0 }),
        ItemAdded: (e, ctx) => ctx.increment('order_summaries', e.aggregate_id, { items: 1, total: e.payload.price }),
        OrderPaid: (e, ctx) => ctx.upsert('order_summaries', { id: e.aggregate_id, status: 'paid' }),
        OrderDeleted: (e, ctx) => ctx.delete('order_summaries', e.aggregate_id),
    },
    ...overrides,
});

interface SetupOptions {
    db?: FakeDatabase;
    store?: MemoryReadModelStore;
    projections?: ProjectionDefinition[];
    capabilities?: Capabilities;
    options?: ProjectionOptions;
    publisher?: IEventPublisher;
}

function setup(setupOptions: SetupOptions = {}) {
    const db = setupOptions.db ?? new FakeDatabase();
    const store = setupOptions.store ?? new MemoryReadModelStore();
    const errors: ProjectionError[] = [];
    const es = new EventStore({
        eventRepository: new FakeEventRepository(db, setupOptions.capabilities),
        sequenceRepository: new FakeSequenceRepository(db),
        snapshotRepository: new FakeSnapshotRepository(db),
        cacheService: new MemoryCacheService(),
        eventPublisher: setupOptions.publisher,
        readModelStore: store,
        projections: setupOptions.projections ?? [orderSummaries()],
        projectionOptions: { onError: error => errors.push(error), ...setupOptions.options },
    });
    return { db, store, es, errors };
}

afterEach(() => {
    vi.useRealTimers();
});

describe('inline projections', () => {
    it('update read models before the append returns, so writers read their own writes', async () => {
        const { db, es } = setup();

        await es.appendEvent(event('OrderCreated', 'o1'));
        await es.appendEvents([event('ItemAdded', 'o1', { price: 10 }), event('ItemAdded', 'o1', { price: 5.5 })]);
        db.resetCalls();
        await es.appendEvent(event('OrderPaid', 'o1'));

        // One read of new events, one commit of read model changes and checkpoint
        expect(db.resetCalls()).toEqual(['appendEvents', 'readAll']);
        expect(await es.readModels.get<OrderSummary>('order_summaries', 'o1')).toEqual({ id: 'o1', status: 'paid', items: 2, total: 15.5 });
    });

    it('serve store-independent queries', async () => {
        const { es } = setup();
        await es.appendEvents([
            event('OrderCreated', 'o1'), event('ItemAdded', 'o1', { price: 30 }),
            event('OrderCreated', 'o2'), event('ItemAdded', 'o2', { price: 10 }), event('OrderPaid', 'o2'),
            event('OrderCreated', 'o3'), event('ItemAdded', 'o3', { price: 20 }), event('OrderPaid', 'o3'),
        ]);

        const paid = await es.readModels.find<OrderSummary>('order_summaries', {
            filter: { status: 'paid', total: { gte: 10 } },
            sort: [{ field: 'total', order: 'desc' }],
            count: true,
        });
        expect(paid).toEqual({ items: [expect.objectContaining({ id: 'o3' }), expect.objectContaining({ id: 'o2' })], total: 2 });

        const page = await es.readModels.find<OrderSummary>('order_summaries', { sort: [{ field: 'id' }], offset: 1, limit: 1 });
        expect(page.items.map(o => o.id)).toEqual(['o2']);
    });

    it('delete rows', async () => {
        const { es } = setup();
        await es.appendEvent(event('OrderCreated', 'o1'));
        await es.appendEvent(event('OrderDeleted', 'o1'));
        expect(await es.readModels.get('order_summaries', 'o1')).toBeNull();
    });

    it('only read event types they handle and skip the others in the checkpoint', async () => {
        const { db, es, store } = setup();
        await es.appendEvents([event('OrderCreated', 'o1'), event('Unrelated', 'x1'), event('Unrelated', 'x2')]);

        db.resetCalls();
        await es.appendEvent(event('Unrelated', 'x3'));
        expect(db.resetCalls()).toEqual(['appendEvents']);

        await es.projections.catchUp();
        const checkpoint = await store.getCheckpoint('order-summaries');
        expect(checkpoint?.position.globalPosition).toBe(4);
    });

    it('see changes made earlier in the batch with get', async () => {
        const store = new MemoryReadModelStore();
        const totals: ProjectionDefinition = {
            name: 'customer-totals',
            collections: [{ name: 'customer_totals', key: 'customer' }],
            handlers: {
                OrderPlaced: async (e, ctx) => {
                    const current = await ctx.get<{ total: number }>('customer_totals', e.payload.customer);
                    ctx.upsert('customer_totals', { customer: e.payload.customer, total: (current?.total ?? 0) + e.payload.amount });
                },
            },
        };
        const { es } = setup({ store, projections: [totals] });

        await es.appendEvents([
            event('OrderPlaced', 'o1', { customer: 'c1', amount: 10 }),
            event('OrderPlaced', 'o2', { customer: 'c1', amount: 5 }),
        ]);
        await es.appendEvent(event('OrderPlaced', 'o3', { customer: 'c1', amount: 1 }));

        expect(await es.readModels.get('customer_totals', 'c1')).toEqual({ customer: 'c1', total: 16 });
    });

    it('wait for events of transactions that are still running', async () => {
        const { db, es, store } = setup({ options: { waitTimeoutMs: 50 } });

        // A transaction that started earlier but has not committed yet
        const open = db.beginTransaction();
        db.openTransactions.add(open);
        db.insertEvent(event('OrderCreated', 'o1'), 1);

        await es.appendEvent(event('OrderCreated', 'o2'));
        expect(store.size('order_summaries')).toBe(0);

        db.openTransactions.delete(open);
        await es.projections.catchUp();
        expect((await es.readModels.find('order_summaries', { sort: [{ field: 'id' }] })).items.map(row => row.id)).toEqual(['o1', 'o2']);
    });

    it('report errors without failing the append; the events stay stored', async () => {
        const { errors, es } = setup({ capabilities: { readAll: false } });

        const saved = await es.appendEvent(event('OrderCreated', 'o1'));
        await es.appendEvent(event('OrderCreated', 'o2'));

        expect(saved.sequence_number).toBe(1);
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toMatch(/es_read_all/);
    });
});

describe('failures', () => {
    it('do not commit a failing batch, are reported once and retried until the handler works', async () => {
        let broken = true;
        const projection = orderSummaries({
            handlers: {
                OrderCreated: (e, ctx) => {
                    if (broken) throw new Error('boom');
                    ctx.upsert('order_summaries', { id: e.aggregate_id, status: 'open' });
                },
            },
        });
        const { errors, es, store } = setup({ projections: [projection] });

        await es.appendEvent(event('OrderCreated', 'o1'));
        await es.appendEvent(event('OrderCreated', 'o2'));

        expect(errors).toHaveLength(1);
        expect(errors[0]).toBeInstanceOf(ProjectionError);
        expect(errors[0]).toMatchObject({ projection: 'order-summaries', event: expect.objectContaining({ aggregate_id: 'o1' }) });
        expect(es.projections.status()[0].lastError?.message).toMatch(/boom/);
        expect(await store.getCheckpoint('order-summaries')).toEqual({ version: 1, position: START_POSITION });

        broken = false;
        await es.projections.catchUp();
        expect(store.size('order_summaries')).toBe(2);
        expect(es.projections.status()[0].lastError).toBeNull();
    });

    it('reject writes to collections the projection does not declare', async () => {
        const projection = orderSummaries({ handlers: { OrderCreated: (e, ctx) => ctx.upsert('other', { id: e.aggregate_id }) } });
        const { errors, es } = setup({ projections: [projection] });

        await es.appendEvent(event('OrderCreated', 'o1'));
        expect(errors[0].message).toMatch(/does not declare collection other/);
    });

    it('reject invalid definitions', () => {
        expect(() => setup({ projections: [orderSummaries(), orderSummaries({ name: 'other' })] })).toThrow(/order_summaries is written by projection order-summaries/);
        expect(() => setup({ projections: [orderSummaries({ handlers: {} })] })).toThrow(/no handlers/);
        expect(() => setup({ projections: [orderSummaries({ version: 0 })] })).toThrow(/positive integer/);
    });
});

describe('several processes', () => {
    it('apply every event exactly once', async () => {
        const db = new FakeDatabase();
        const store = new MemoryReadModelStore();
        const counter: ProjectionDefinition = {
            name: 'counter',
            collections: ['counters'],
            handlers: { Tick: (_e, ctx) => ctx.increment('counters', 'all', { n: 1 }) },
        };
        const a = setup({ db, store, projections: [counter] }).es;
        const b = setup({ db, store, projections: [counter] }).es;

        for (let i = 0; i < 10; i++) {
            await Promise.all([a.appendEvent(event('Tick', `a${i}`)), b.appendEvent(event('Tick', `b${i}`))]);
        }
        // b's checkpoint in memory is now behind: its next batch conflicts and continues from the store
        await a.appendEvent(event('Tick', 'a-last'));
        await b.appendEvent(event('Tick', 'b-last'));

        expect(await a.readModels.get('counters', 'all')).toEqual({ id: 'all', n: 22 });
    });

    it('rebuild after a version bump, while older versions leave the newer one alone', async () => {
        const db = new FakeDatabase();
        const store = new MemoryReadModelStore();
        const v1 = setup({ db, store, projections: [orderSummaries()] });
        await v1.es.appendEvents([event('OrderCreated', 'o1'), event('OrderPaid', 'o1')]);

        const upper: ProjectionDefinition = orderSummaries({
            version: 2,
            handlers: { OrderCreated: (e, ctx) => ctx.upsert('order_summaries', { id: e.aggregate_id, status: 'OPEN' }) },
        });
        const v2 = setup({ db, store, projections: [upper] });
        await v2.es.projections.catchUp();
        expect(await v2.es.readModels.get('order_summaries', 'o1')).toEqual({ id: 'o1', status: 'OPEN' });

        await v1.es.appendEvent(event('OrderCreated', 'o2'));
        expect(v1.errors[0].message).toMatch(/stored with version 2; this process runs version 1/);
        expect(await v2.es.readModels.get('order_summaries', 'o1')).toEqual({ id: 'o1', status: 'OPEN' });
    });

    it('rebuild on request', async () => {
        const { es, store } = setup();
        await es.appendEvents([event('OrderCreated', 'o1'), event('OrderPaid', 'o1')]);
        await store.commit({
            projection: 'order-summaries', version: 1,
            expected: (await store.getCheckpoint('order-summaries'))!.position,
            next: (await store.getCheckpoint('order-summaries'))!.position,
            changes: [{ op: 'upsert', collection: 'order_summaries', key: { id: 'stray' }, row: { id: 'stray' }, position: START_POSITION }],
        });

        await es.projections.rebuild('order-summaries');
        expect((await es.readModels.find('order_summaries')).items).toEqual([{ id: 'o1', status: 'paid', items: 0, total: 0 }]);
    });
});

describe('async projections', () => {
    it('are not processed on append; consistentWith waits for them', async () => {
        const { db, es, store } = setup({ projections: [orderSummaries({ mode: 'async' })] });

        db.resetCalls();
        const created = await es.appendEvent(event('OrderCreated', 'o1'));
        expect(db.resetCalls()).toEqual(['appendEvents']);
        expect(store.size('order_summaries')).toBe(0);

        const page = await es.readModels.find('order_summaries', { consistentWith: created });
        expect(page.items).toHaveLength(1);
        expect(await es.readModels.get('order_summaries', 'o1', { consistentWith: created })).toMatchObject({ status: 'open' });
    });

    it('are processed in the background until stopped', async () => {
        const { es, store } = setup({ projections: [orderSummaries({ mode: 'async' })] });
        es.projections.start({ intervalMs: 5 });

        await es.appendEvent(event('OrderCreated', 'o1'));
        await vi.waitFor(() => expect(store.size('order_summaries')).toBe(1));

        await es.projections.stop();
        await es.appendEvent(event('OrderCreated', 'o2'));
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(store.size('order_summaries')).toBe(1);
    });

    it('wake up on published events with realtime', async () => {
        const listeners: Array<(e: EventRecord) => void> = [];
        const publisher: IEventPublisher = {
            subscribe: callback => {
                listeners.push(callback);
                return () => listeners.splice(listeners.indexOf(callback), 1);
            },
        };
        const { es, store } = setup({ projections: [orderSummaries({ mode: 'async' })], publisher });
        es.projections.start({ intervalMs: 60_000, realtime: true });
        await vi.waitFor(() => expect(es.projections.status()[0].position).not.toBeNull());

        const created = await es.appendEvent(event('OrderCreated', 'o1'));
        listeners.forEach(listener => listener(created));
        await vi.waitFor(() => expect(store.size('order_summaries')).toBe(1));

        await es.projections.stop();
        expect(listeners).toHaveLength(0);
    });

    it('time out when consistentWith cannot be reached', async () => {
        const { db, es } = setup({ projections: [orderSummaries({ mode: 'async' })], options: { waitTimeoutMs: 30 } });
        const open = db.beginTransaction();
        db.openTransactions.add(open);
        db.insertEvent(event('OrderCreated', 'o0'), 1);
        const created = await es.appendEvent(event('OrderCreated', 'o1'));

        await expect(es.readModels.find('order_summaries', { consistentWith: created })).rejects.toThrow(/did not reach position/);
    });
});

describe('read models', () => {
    it('can be queried without a projection from the default store', async () => {
        const { es } = setup();
        expect(await es.readModels.find('anything')).toEqual({ items: [] });
        await expect(es.readModels.find('anything', { consistentWith: START_POSITION })).rejects.toThrow(/not written by a projection/);
    });

    it('accept composite keys', async () => {
        const lines: ProjectionDefinition = {
            name: 'lines',
            collections: [{ name: 'order_lines', key: ['order_id', 'line'] }],
            handlers: {
                LineAdded: (e, ctx) => ctx.upsert('order_lines', { order_id: e.aggregate_id, line: e.payload.line, sku: e.payload.sku }),
            },
        };
        const { es } = setup({ projections: [lines] });
        await es.appendEvents([event('LineAdded', 'o1', { line: 1, sku: 'A' }), event('LineAdded', 'o1', { line: 2, sku: 'B' })]);

        expect(await es.readModels.get('order_lines', { order_id: 'o1', line: 2 })).toEqual({ order_id: 'o1', line: 2, sku: 'B' });
        await expect(es.readModels.get('order_lines', 'o1')).rejects.toThrow(/composite key/);
    });
});

describe('readAll', () => {
    it('pages through all events in commit order', async () => {
        const { es } = setup({ projections: [] });
        await es.appendEvents([event('A', 'x'), event('B', 'y')]);
        await es.appendEvent(event('C', 'x'));

        const first = await es.readAll(START_POSITION, { limit: 2 });
        expect(first.events.map(e => e.type)).toEqual(['A', 'B']);
        expect(first.done).toBe(false);

        const second = await es.readAll(first.next, { limit: 2 });
        expect(second.events.map(e => e.type)).toEqual(['C']);
        expect(second.done).toBe(true);
    });
});

describe('upserts', () => {
    it('leave columns set to undefined unchanged and clear columns set to null', async () => {
        const notes: ProjectionDefinition = {
            name: 'notes',
            collections: ['notes'],
            handlers: { Noted: (e, ctx) => ctx.upsert('notes', { id: e.aggregate_id, title: e.payload.title, body: e.payload.body }) },
        };
        const { es } = setup({ projections: [notes] });

        await es.appendEvent(event('Noted', 'n1', { title: 'T', body: 'B' }));
        await es.appendEvent(event('Noted', 'n1', { body: null }));

        expect(await es.readModels.get('notes', 'n1')).toEqual({ id: 'n1', title: 'T', body: null });
    });
});

describe('waiting', () => {
    it('honours the timeout when a handler appends to its own projection', async () => {
        let es!: EventStore;
        const reentrant: ProjectionDefinition = {
            name: 'reentrant',
            collections: ['log'],
            handlers: {
                Ping: async (e, ctx) => {
                    ctx.upsert('log', { id: e.aggregate_id });
                    if (!e.payload.nested) await es.appendEvent(event('Ping', `${e.aggregate_id}-nested`, { nested: true }));
                },
            },
        };
        const result = setup({ projections: [reentrant], options: { waitTimeoutMs: 50 } });
        es = result.es;

        await es.appendEvent(event('Ping', 'p1'));
        expect(result.errors[0].message).toMatch(/did not reach position/);

        await es.projections.catchUp();
        expect(result.store.size('log')).toBe(2);
    });

    it('numbers the changes of each event', async () => {
        const store = new MemoryReadModelStore();
        const commits: ProjectionCommit[] = [];
        const commit = store.commit.bind(store);
        store.commit = async batch => {
            commits.push(batch);
            return commit(batch);
        };
        const { es } = setup({ store });

        await es.appendEvents([event('OrderCreated', 'o1'), event('ItemAdded', 'o1', { price: 1 })]);
        expect(commits.at(-1)!.changes.map(change => [change.op, change.ordinal])).toEqual([['upsert', 0], ['increment', 0]]);
    });
});
