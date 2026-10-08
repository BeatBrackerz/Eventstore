import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import type {SupabaseClient} from '@supabase/supabase-js';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {
    type CreateEventInput,
    createEventStore,
    type EventStoreBuilderConfig,
    type ProjectionDefinition,
    type ProjectionError,
    START_POSITION,
    SupabaseReadModelStore,
} from '../../src/index.js';
import {integrationEnv, postgresEnv, RestProxy, serviceRoleClient} from '../support/postgrest.js';

const env = integrationEnv();
const pg = postgresEnv();
const USER = randomUUID();

interface OrderSummary {
    id: string;
    customer: string;
    status: string;
    items: number;
    total: number;
    title: string | null;
}

const event = (type: string, aggregateId: string, payload: Record<string, unknown> = {}): CreateEventInput => ({
    type,
    aggregate_id: aggregateId,
    aggregate_type: 'order',
    created_by: USER,
    payload,
});

// Every test uses its own projection names; tables are shared, so rows are scoped by customer
const summaries = (name: string, overrides: Partial<ProjectionDefinition> = {}): ProjectionDefinition => ({
    name,
    collections: [{ name: 'it_order_summaries', search: { column: 'fts', config: 'simple' } }],
    handlers: {
        OrderCreated: (e, ctx) => ctx.upsert('it_order_summaries', { id: e.aggregate_id, customer: e.payload.customer, title: e.payload.title }),
        ItemAdded: (e, ctx) => ctx.increment('it_order_summaries', e.aggregate_id, { items: 1, total: e.payload.price }),
        OrderPaid: (e, ctx) => ctx.upsert('it_order_summaries', { id: e.aggregate_id, status: 'paid' }),
        OrderDeleted: (e, ctx) => ctx.delete('it_order_summaries', e.aggregate_id),
    },
    ...overrides,
});

describe.skipIf(!env)('projections against PostgREST', () => {
    const proxy = new RestProxy(env?.url ?? '');
    let client: SupabaseClient;
    let url: string;
    const errors: ProjectionError[] = [];

    beforeAll(async () => {
        url = await proxy.start();
        client = serviceRoleClient(url, env!.jwtSecret);
    });

    afterAll(async () => {
        await proxy.stop();
    });

    beforeEach(() => {
        proxy.reset();
        errors.length = 0;
    });

    // Tests share one read model table, so each uses its own projection name and owns the table
    // only for its duration: a store per test keeps collection ownership local to the EventStore
    const store = (config: Partial<EventStoreBuilderConfig> = {}) =>
        createEventStore({ supabase: client, projectionOptions: { onError: error => errors.push(error) }, ...config });

    it('keeps a table up to date with one extra request per append and serves queries from it', async () => {
        const customer = `c-${randomUUID()}`;
        const [o1, o2, o3] = [randomUUID(), randomUUID(), randomUUID()];
        const es = store({ projections: [summaries(`summaries-${randomUUID()}`)] });

        await es.appendEvents([
            event('OrderCreated', o1, { customer, title: 'Blue running shoes' }),
            event('ItemAdded', o1, { price: 30 }),
            event('OrderCreated', o2, { customer, title: 'Red hat' }),
            event('ItemAdded', o2, { price: 12.5 }), event('ItemAdded', o2, { price: 7.5 }), event('OrderPaid', o2),
        ]);
        expect(errors).toEqual([]);

        proxy.reset();
        await es.appendEvents([event('OrderCreated', o3, { customer, title: 'Blue hat' }), event('OrderPaid', o3)]);
        expect(proxy.reset()).toEqual(['POST /rpc/es_append_events', 'POST /rpc/es_read_all', 'POST /rpc/es_project']);

        expect(await es.readModels.get<OrderSummary>('it_order_summaries', o2))
            .toMatchObject({ id: o2, customer, status: 'paid', items: 2, total: 20, title: 'Red hat' });

        const paid = await es.readModels.find<OrderSummary>('it_order_summaries', {
            filter: { customer, status: 'paid' },
            sort: [{ field: 'total', order: 'desc' }],
            count: true,
        });
        expect(paid.total).toBe(2);
        expect(paid.items.map(o => o.id)).toEqual([o2, o3]);

        const blue = await es.readModels.find<OrderSummary>('it_order_summaries', { filter: { customer }, search: 'blue', sort: [{ field: 'title' }] });
        expect(blue.items.map(o => o.title)).toEqual(['Blue hat', 'Blue running shoes']);
        expect(proxy.reset()).toEqual([
            `GET /it_order_summaries`,
            `GET /it_order_summaries`,
            `GET /it_order_summaries`,
        ]);

        await es.appendEvent(event('OrderDeleted', o1));
        expect(await es.readModels.get('it_order_summaries', o1)).toBeNull();
    });

    it('writes composite keys and pages large queries', async () => {
        const order = randomUUID();
        const es = store({
            pageSize: 100,
            projections: [{
                name: `lines-${randomUUID()}`,
                collections: [{ name: 'it_order_lines', key: ['order_id', 'line'] }],
                handlers: { LineAdded: (e, ctx) => ctx.upsert('it_order_lines', { order_id: e.aggregate_id, line: e.payload.line, sku: `S${e.payload.line}` }) },
            }],
        });

        await es.appendEvents(Array.from({ length: 250 }, (_, i) => event('LineAdded', order, { line: i + 1 })));

        const page = await es.readModels.find('it_order_lines', { filter: { order_id: order }, sort: [{ field: 'line' }], limit: 240, offset: 5, count: true });
        expect(page.total).toBe(250);
        expect(page.items).toHaveLength(240);
        expect(page.items[0]).toEqual({ order_id: order, line: 6, sku: 'S6' });
        expect(await es.readModels.get('it_order_lines', { order_id: order, line: 250 })).toEqual({ order_id: order, line: 250, sku: 'S250' });
    });

    it('applies every batch exactly once with several concurrent projectors', async () => {
        const counter: ProjectionDefinition = {
            name: `counter-${randomUUID()}`,
            collections: ['it_counters'],
            handlers: { Tick: (e, ctx) => ctx.increment('it_counters', e.payload.counter, { n: 1 }) },
            aggregateTypes: ['order'],
        };
        const counterId = randomUUID();
        // Separate clients: like separate instances of an application
        const instances = Array.from({ length: 4 }, () => createEventStore({
            supabase: serviceRoleClient(url, env!.jwtSecret),
            projections: [counter],
            projectionOptions: { onError: error => errors.push(error), batchSize: 7 },
        }));

        await Promise.all(Array.from({ length: 60 }, (_, i) =>
            instances[i % instances.length].appendEvent(event('Tick', randomUUID(), { counter: counterId }))
        ));
        await Promise.all(instances.map(es => es.projections.catchUp()));

        expect(errors).toEqual([]);
        expect(await instances[0].readModels.get('it_counters', counterId)).toEqual({ id: counterId, n: 60 });
    });

    it('processes async projections on demand and reports progress in es_projection_status', async () => {
        const name = `async-${randomUUID()}`;
        const customer = `c-${randomUUID()}`;
        const es = store({ projections: [summaries(name, { mode: 'async' })] });
        await es.projections.catchUp();

        const order = randomUUID();
        const created = await es.appendEvent(event('OrderCreated', order, { customer }));

        const pending = await client.from('es_projection_status').select('pending_events, oldest_pending_at').eq('name', name).single();
        expect(pending.data?.pending_events).toBeGreaterThanOrEqual(1);
        expect(pending.data?.oldest_pending_at).not.toBeNull();

        const page = await es.readModels.find('it_order_summaries', { filter: { customer }, consistentWith: created });
        expect(page.items.map(o => o.id)).toEqual([order]);

        const done = await client.from('es_projection_status').select('pending_events, oldest_pending_at').eq('name', name).single();
        expect(done.data).toEqual({ pending_events: 0, oldest_pending_at: null });
    });

    it('rebuilds the table after a version bump', async () => {
        const name = `rebuild-${randomUUID()}`;
        const customer = `c-${randomUUID()}`;
        const order = randomUUID();
        await store({ projections: [summaries(name)] }).appendEvent(event('OrderCreated', order, { customer, title: 'v1' }));

        const v2 = store({
            projections: [summaries(name, {
                version: 2,
                handlers: { OrderCreated: (e, ctx) => ctx.upsert('it_order_summaries', { id: e.aggregate_id, customer: e.payload.customer, title: 'v2' }) },
            })],
        });
        await v2.projections.catchUp();

        expect(await v2.readModels.get('it_order_summaries', order)).toMatchObject({ title: 'v2' });
        const checkpoint = await new SupabaseReadModelStore(client).getCheckpoint(name);
        expect(checkpoint?.version).toBe(2);
    });

    it('reads all events in commit order', async () => {
        const es = store();
        const first = await es.appendEvent(event('A', randomUUID()));
        const second = await es.appendEvents([event('B', randomUUID()), event('C', randomUUID())]);

        const after = { transactionId: first.transaction_id!, globalPosition: first.global_position! - 1 };
        const page = await es.readAll(after, { limit: 2 });
        expect(page.events.map(e => e.id)).toEqual([first.id, second[0].id]);
        expect(page.done).toBe(false);

        const rest = await es.readAll(page.next, { eventTypes: ['C'] });
        expect(rest.events.map(e => e.id)).toContain(second[1].id);
    });

    it('rejects read model changes to the event store tables', async () => {
        const { error } = await client.rpc('es_project', {
            p_projection: `evil-${randomUUID()}`, p_version: 1,
            p_expected_transaction_id: '0', p_expected_position: 0, p_transaction_id: '1', p_position: 1,
            p_changes: [{ op: 'delete', table: 'events', key: ['id'], columns: ['id'], rows: [] }],
        });
        expect(error?.message).toMatch(/not a read model table/);
    });

    it('does not let the anon role read all events or write read models', async () => {
        const anon = serviceRoleClient(url, env!.jwtSecret, 'anon');
        const read = await anon.rpc('es_read_all', {});
        const project = await anon.rpc('es_reset_projection', { p_projection: 'x', p_version: 1 });
        expect(read.error?.code).toBe('42501');
        expect(project.error?.code).toBe('42501');
    });

    it('can be created without projections and still query any table', async () => {
        const page = await store().readModels.find('it_counters', { limit: 1 });
        expect(Array.isArray(page.items)).toBe(true);
        await expect(store().readModels.find('it_counters', { consistentWith: START_POSITION })).rejects.toThrow(/not written by a projection/);
    });

    describe.skipIf(!pg)('with direct database access', () => {
        it('holds back events committed after a transaction that is still running', async () => {
            const es = store();
            const anchor = await es.appendEvent(event('Anchor', randomUUID()));
            const after = { transactionId: anchor.transaction_id!, globalPosition: anchor.global_position! };

            // An append that stays uncommitted for a moment
            const slow = randomUUID();
            const events = JSON.stringify([event('Slow', slow)]);
            const psql = spawn('psql', ['-v', 'ON_ERROR_STOP=1', '-qAt', '-d', 'es_it', '-c',
                `begin; select count(*) from json_array_elements(public.es_append_events('${events}'::jsonb)); select pg_sleep(1.5); commit;`]);
            const exited = new Promise<number | null>(resolve => psql.on('exit', resolve));
            await waitUntil(() => pg!.psql('es_it', `select count(*) from pg_stat_activity where query like '%pg_sleep(1.5)%' and state = 'active' and pid <> pg_backend_pid()`) === '1');

            const fast = await es.appendEvent(event('Fast', randomUUID()));
            const during = await es.readAll(after);
            expect(during.events.map(e => e.id)).not.toContain(fast.id);

            expect(await exited).toBe(0);
            const later = await es.readAll(after);
            expect(later.events.map(e => [e.type, e.aggregate_id])).toEqual([['Slow', slow], ['Fast', fast.aggregate_id]]);
        });

        it('upgrades an existing events table and keeps every aggregate in sequence order', () => {
            pg!.psql('postgres', 'drop database if exists es_it_upgrade');
            pg!.psql('postgres', 'create database es_it_upgrade');
            pg!.psql('es_it_upgrade', readFileSync('test/integration/legacy-schema.sql', 'utf8'));
            // Aggregate b is stored out of order: sequence 2 before sequence 1
            pg!.psql('es_it_upgrade', `insert into events (type, aggregate_id, aggregate_type, sequence_number, created_by) values
                ('a1', '00000000-0000-0000-0000-00000000000a', 't', 1, gen_random_uuid()),
                ('b2', '00000000-0000-0000-0000-00000000000b', 't', 2, gen_random_uuid()),
                ('a2', '00000000-0000-0000-0000-00000000000a', 't', 2, gen_random_uuid()),
                ('b1', '00000000-0000-0000-0000-00000000000b', 't', 1, gen_random_uuid())`);

            const sql = readFileSync('sql/eventstore.sql', 'utf8');
            pg!.psql('es_it_upgrade', sql);
            pg!.psql('es_it_upgrade', sql);
            pg!.psql('es_it_upgrade', `insert into events (type, aggregate_id, aggregate_type, sequence_number, created_by)
                values ('a3', '00000000-0000-0000-0000-00000000000a', 't', 3, gen_random_uuid())`);

            expect(pg!.psql('es_it_upgrade', `select string_agg(type, ',' order by transaction_id, global_position) from events`))
                .toBe('a1,b1,a2,b2,a3');
            expect(pg!.psql('es_it_upgrade', `select attidentity from pg_attribute where attrelid = 'events'::regclass and attname = 'global_position'`))
                .toBe('a');
            expect(pg!.psql('es_it_upgrade', `select substr(id::text, 15, 1) from events where type = 'a3'`)).toBe('7');
        });
    });
});

async function waitUntil(condition: () => boolean, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error('Timed out');
        await new Promise(resolve => setTimeout(resolve, 20));
    }
}
