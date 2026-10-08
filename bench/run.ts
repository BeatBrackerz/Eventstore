/**
 * Compares database round trips and latency of common operations against a real PostgREST.
 *
 *   npm run build
 *   BENCH_BASELINE=/path/to/v1.1.1/dist/cjs/index.js npm run bench   # baseline is optional
 *
 * Requires the integration test environment (see CONTRIBUTING.md). BENCH_LATENCY_MS (default 20)
 * is added to every request to simulate the network between application and Supabase.
 */
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {integrationEnv, RestProxy, serviceRoleClient} from '../test/support/postgrest.ts';
import * as current from '../dist/esm/index.js';

interface Store {
    appendEvent(event: object): Promise<unknown>;
    appendEvents(events: object[]): Promise<unknown>;
    createSnapshot(snapshot: object): Promise<unknown>;
    getAggregateEvents(id: string, type: string): Promise<unknown[]>;
    replayEvents(id: string, type: string, projection: object): Promise<unknown>;
    getAggregateStats(id: string, type: string): Promise<{ totalEvents: number }>;
}

interface Variant {
    name: string;
    proxy: RestProxy;
    create(): Store;
}

interface Measurement {
    ms: number;
    requests: number;
    kb: number;
    note?: string;
}

const env = integrationEnv();
if (!env) {
    console.error('Set EVENTSTORE_IT_POSTGREST_URL, EVENTSTORE_IT_POSTGREST_LEGACY_URL and EVENTSTORE_IT_JWT_SECRET (see CONTRIBUTING.md).');
    process.exit(1);
}

const LATENCY_MS = Number(process.env.BENCH_LATENCY_MS ?? 20);
const TYPE = 'bench';
const USER = randomUUID();
const projection = { initialState: { count: 0 }, applyEvent: (state: { count: number }) => ({ count: state.count + 1 }) };
const input = (id: string, i: number) => ({ type: `E${i}`, aggregate_id: id, aggregate_type: TYPE, created_by: USER, payload: { i, text: 'x'.repeat(200) } });

const functionsProxy = new RestProxy(env.url);
const legacyProxy = new RestProxy(env.legacyUrl);
const functionsClient = serviceRoleClient(await functionsProxy.start(), env.jwtSecret);
const legacyClient = serviceRoleClient(await legacyProxy.start(), env.jwtSecret);

const variants: Variant[] = [];
if (process.env.BENCH_BASELINE) {
    const baseline = createRequire(import.meta.url)(process.env.BENCH_BASELINE);
    variants.push({ name: 'v1.1.1 (no Redis)', proxy: legacyProxy, create: () => baseline.createEventStore({ supabase: legacyClient }) });
}
variants.push(
    { name: 'new, without SQL migration', proxy: legacyProxy, create: () => current.createEventStore({ supabase: legacyClient }) as Store },
    { name: 'new, with SQL migration', proxy: functionsProxy, create: () => current.createEventStore({ supabase: functionsClient }) as Store },
    {
        name: 'new, with SQL migration, maxStalenessMs: 2000',
        proxy: functionsProxy,
        create: () => current.createEventStore({ supabase: functionsClient, cache: { maxStalenessMs: 2000 } }) as Store,
    },
);

/** A long-lived store as in an application, after its first request */
async function warmStore(variant: Variant): Promise<Store> {
    const store = variant.create();
    await store.appendEvent(input(randomUUID(), 0));
    return store;
}

async function prepare(variant: Variant, aggregates: number, events: number, snapshotAt?: number): Promise<string[]> {
    variant.proxy.latencyMs = 0;
    const store = current.createEventStore({ supabase: variant.proxy === functionsProxy ? functionsClient : legacyClient });
    const ids = Array.from({ length: aggregates }, () => randomUUID());
    for (const id of ids) {
        for (let done = 0; done < events; done += 500) {
            await store.appendEvents(Array.from({ length: Math.min(500, events - done) }, (_, i) => input(id, done + i + 1)));
        }
        if (snapshotAt) {
            await store.createSnapshot({ aggregate_id: id, aggregate_type: TYPE, sequence_number: snapshotAt, state: { count: snapshotAt } });
        }
    }
    return ids;
}

async function measure(variant: Variant, runs: number, operation: (run: number) => Promise<string | void>): Promise<Measurement> {
    variant.proxy.latencyMs = LATENCY_MS;
    variant.proxy.reset();
    let note: string | void = undefined;
    const started = performance.now();
    for (let run = 0; run < runs; run++) note = await operation(run);
    const ms = (performance.now() - started) / runs;
    const measurement = { ms, requests: variant.proxy.requests.length / runs, kb: variant.proxy.responseBytes / 1024 / runs, note: note ?? undefined };
    variant.proxy.latencyMs = 0;
    return measurement;
}

const scenarios: Array<{ title: string; run(variant: Variant): Promise<Measurement> }> = [
    {
        title: 'Append one event',
        async run(variant) {
            const store = await warmStore(variant);
            const id = randomUUID();
            return measure(variant, 20, i => store.appendEvent(input(id, i + 1)).then(() => undefined));
        },
    },
    {
        title: 'Load aggregate state (replayEvents, 60 events, snapshot at 50), first time',
        async run(variant) {
            const ids = await prepare(variant, 10, 60, 50);
            const store = await warmStore(variant);
            return measure(variant, ids.length, i => store.replayEvents(ids[i], TYPE, projection).then(() => undefined));
        },
    },
    {
        title: 'Load aggregate state again (replayEvents)',
        async run(variant) {
            const ids = await prepare(variant, 10, 60, 50);
            const store = await warmStore(variant);
            for (const id of ids) await store.replayEvents(id, TYPE, projection);
            return measure(variant, ids.length, i => store.replayEvents(ids[i], TYPE, projection).then(() => undefined));
        },
    },
    {
        title: 'Read aggregate events again (getAggregateEvents, 60 events)',
        async run(variant) {
            const ids = await prepare(variant, 10, 60);
            const store = await warmStore(variant);
            for (const id of ids) await store.getAggregateEvents(id, TYPE);
            return measure(variant, ids.length, i => store.getAggregateEvents(ids[i], TYPE).then(() => undefined));
        },
    },
    {
        title: '10 concurrent reads of the same aggregate (60 events, first time)',
        async run(variant) {
            const ids = await prepare(variant, 5, 60);
            const store = await warmStore(variant);
            return measure(variant, ids.length, async i => {
                await Promise.all(Array.from({ length: 10 }, () => store.getAggregateEvents(ids[i], TYPE)));
            });
        },
    },
    {
        title: 'Aggregate statistics (2,500 events)',
        async run(variant) {
            const [id] = await prepare(variant, 1, 2500);
            const store = await warmStore(variant);
            return measure(variant, 1, async () => `totalEvents = ${(await store.getAggregateStats(id, TYPE)).totalEvents}`);
        },
    },
    {
        title: 'Read a long stream (getAggregateEvents, 2,500 events)',
        async run(variant) {
            const [id] = await prepare(variant, 1, 2500);
            const store = await warmStore(variant);
            return measure(variant, 1, async () => `${(await store.getAggregateEvents(id, TYPE)).length} events returned`);
        },
    },
];

console.log(`Simulated latency per request: ${LATENCY_MS} ms\n`);
for (const scenario of scenarios) {
    console.log(`### ${scenario.title}\n`);
    console.log('| Variant | Time | Requests | Transferred | |');
    console.log('|---|---:|---:|---:|---|');
    let reference: number | undefined;
    for (const variant of variants) {
        const m = await scenario.run(variant);
        reference ??= m.ms;
        const speedup = reference / m.ms >= 1.05 ? ` (${(reference / m.ms).toFixed(1)}× faster)` : '';
        console.log(`| ${variant.name} | ${m.ms.toFixed(1)} ms${speedup} | ${m.requests.toFixed(1)} | ${m.kb.toFixed(1)} KB | ${m.note ?? ''} |`);
    }
    console.log('');
}

// ============================================================================
// Read models: list queries served by a projection instead of replaying aggregates
// ============================================================================

const ORDERS = 20;
const EVENTS_PER_ORDER = 10;
const customer = `bench-${randomUUID()}`;
const summaries = {
    name: `bench-summaries-${randomUUID()}`,
    collections: ['it_order_summaries'],
    aggregateTypes: ['bench-order'],
    handlers: {
        BenchOrderCreated: (e: any, ctx: any) => ctx.upsert('it_order_summaries', { id: e.aggregate_id, customer: e.payload.customer }),
        BenchItemAdded: (e: any, ctx: any) => ctx.increment('it_order_summaries', e.aggregate_id, { items: 1, total: e.payload.price }),
    },
};
const orderEvents = (id: string) => [
    { type: 'BenchOrderCreated', aggregate_id: id, aggregate_type: 'bench-order', created_by: USER, payload: { customer } },
    ...Array.from({ length: EVENTS_PER_ORDER - 1 }, () => (
        { type: 'BenchItemAdded', aggregate_id: id, aggregate_type: 'bench-order', created_by: USER, payload: { price: 10 } }
    )),
];
const summary = {
    initialState: { items: 0, total: 0 },
    applyEvent: (state: { items: number; total: number }, e: any) =>
        e.type === 'BenchItemAdded' ? { items: state.items + 1, total: state.total + e.payload.price } : state,
};

const functionsVariant = variants.find(variant => variant.proxy === functionsProxy && variant.name === 'new, with SQL migration')!;
const withProjection = (mode: 'inline' | 'async') =>
    current.createEventStore({ supabase: functionsClient, projections: [{ ...summaries, mode }] });

functionsProxy.latencyMs = 0;
const writer = withProjection('inline');
const orderIds = Array.from({ length: ORDERS }, () => randomUUID());
for (const id of orderIds) await writer.appendEvents(orderEvents(id));

const readModelRows: Array<[string, Measurement]> = [
    [
        `List ${ORDERS} orders by replaying each aggregate (${EVENTS_PER_ORDER} events, first time)`,
        await measure(functionsVariant, 1, async () => {
            const store = current.createEventStore({ supabase: functionsClient });
            await Promise.all(orderIds.map(id => store.replayEvents(id, 'bench-order', summary)));
        }),
    ],
    [
        `List ${ORDERS} orders from the read model (readModels.find)`,
        await measure(functionsVariant, 10, async () => {
            const page = await writer.readModels.find('it_order_summaries', { filter: { customer }, sort: [{ field: 'id' }], limit: ORDERS });
            return `${page.items.length} rows`;
        }),
    ],
    [
        'Append one event, inline projection (read-your-writes)',
        await measure(functionsVariant, 20, () => writer.appendEvent(orderEvents(orderIds[0])[1]).then(() => undefined)),
    ],
    [
        'Append one event, async projection',
        await measure(functionsVariant, 20, () => withProjection('async').appendEvent(orderEvents(orderIds[0])[1]).then(() => undefined)),
    ],
];

console.log('### Read models (with SQL migration)\n');
console.log('| Operation | Time | Requests | Transferred | |');
console.log('|---|---:|---:|---:|---|');
for (const [title, m] of readModelRows) {
    console.log(`| ${title} | ${m.ms.toFixed(1)} ms | ${m.requests.toFixed(1)} | ${m.kb.toFixed(1)} KB | ${m.note ?? ''} |`);
}
console.log('');

await Promise.all([functionsProxy.stop(), legacyProxy.stop()]);
