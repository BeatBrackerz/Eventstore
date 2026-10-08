import {describe, expect, it} from 'vitest';
import {
    type ElasticsearchClientLike,
    ElasticsearchReadModelStore,
    MemoryReadModelStore,
    type Position,
    type ReadModelChange,
    type ReadModelCollection,
    START_POSITION,
} from '../../src/index.js';
import {toStatements} from '../../src/adapters/SupabaseReadModelStore.js';

const at = (globalPosition: number, transactionId = '7'): Position => ({ transactionId, globalPosition });

describe('MemoryReadModelStore', () => {
    const products: ReadModelCollection = { name: 'products', search: { fields: ['name'] } };

    async function seeded() {
        const store = new MemoryReadModelStore();
        const rows = [
            { id: 'p1', name: 'Red Shoe', price: 50, tag: 'sale' },
            { id: 'p2', name: 'Blue Shoe', price: 80, tag: null },
            { id: 'p3', name: 'Red Hat', price: 20, tag: 'new' },
            { id: 'p4', name: 'Green Scarf', price: 35 },
        ];
        await store.commit({
            projection: 'p', version: 1, expected: START_POSITION, next: at(4),
            changes: rows.map(row => ({ op: 'upsert', collection: 'products', key: { id: row.id }, row, position: at(1) })),
        });
        return store;
    }

    const ids = (page: { items: Array<Record<string, unknown>> }) => page.items.map(row => row.id);

    it('filters, searches, sorts and pages', async () => {
        const store = await seeded();

        expect(ids(await store.find(products, { filter: { price: { gt: 20, lte: 50 } }, sort: [{ field: 'price' }] }))).toEqual(['p4', 'p1']);
        expect(ids(await store.find(products, { filter: { tag: { in: ['sale', 'new'] } }, sort: [{ field: 'id' }] }))).toEqual(['p1', 'p3']);
        expect(ids(await store.find(products, { filter: { tag: null }, sort: [{ field: 'id' }] }))).toEqual(['p2', 'p4']);
        expect(ids(await store.find(products, { filter: { tag: { neq: null } }, sort: [{ field: 'id' }] }))).toEqual(['p1', 'p3']);
        expect(ids(await store.find(products, { search: 'red', sort: [{ field: 'price', order: 'desc' }] }))).toEqual(['p1', 'p3']);
        expect(await store.find(products, { sort: [{ field: 'price', order: 'desc' }], offset: 1, limit: 2, count: true }))
            .toEqual({ items: [expect.objectContaining({ id: 'p1' }), expect.objectContaining({ id: 'p4' })], total: 4 });
    });

    it('commits only from the expected checkpoint and version', async () => {
        const store = await seeded();
        const change: ReadModelChange = { op: 'delete', collection: 'products', key: { id: 'p1' }, position: at(5) };

        expect(await store.commit({ projection: 'p', version: 1, expected: at(3), next: at(5), changes: [change] })).toBe(false);
        expect(await store.commit({ projection: 'p', version: 2, expected: at(4), next: at(5), changes: [change] })).toBe(false);
        expect(store.size('products')).toBe(4);

        expect(await store.commit({ projection: 'p', version: 1, expected: at(4), next: at(5), changes: [change] })).toBe(true);
        expect(store.size('products')).toBe(3);
    });

    it('returns copies', async () => {
        const store = await seeded();
        const row = await store.get<{ name: string }>(products, { id: 'p1' });
        row!.name = 'changed';
        expect(await store.get(products, { id: 'p1' })).toMatchObject({ name: 'Red Shoe' });
    });
});

describe('statements of es_project', () => {
    const upsert = (id: string, row: Record<string, unknown>): ReadModelChange =>
        ({ op: 'upsert', collection: 't', key: { id }, row: { id, ...row }, position: START_POSITION });
    const increment = (id: string, values: Record<string, number>): ReadModelChange =>
        ({ op: 'increment', collection: 't', key: { id }, values, position: START_POSITION });

    it('groups consecutive changes with the same columns and merges changes to the same row', () => {
        const statements = toStatements([
            upsert('a', { name: 'A', status: 'new' }),
            upsert('b', { status: 'new', name: 'B' }),
            upsert('a', { name: 'A2', status: 'paid' }),
            increment('a', { n: 1 }),
            increment('a', { n: 2 }),
            increment('b', { n: 1 }),
            upsert('a', { status: 'done' }),
            { op: 'delete', collection: 't', key: { id: 'b' }, position: START_POSITION },
            { op: 'delete', collection: 't', key: { id: 'b' }, position: START_POSITION },
        ]);

        expect(statements).toEqual([
            {
                op: 'upsert', table: 't', key: ['id'], columns: ['id', 'name', 'status'],
                rows: [{ id: 'a', name: 'A2', status: 'paid' }, { id: 'b', status: 'new', name: 'B' }],
            },
            { op: 'increment', table: 't', key: ['id'], columns: ['id', 'n'], rows: [{ id: 'a', n: 3 }, { id: 'b', n: 1 }] },
            { op: 'upsert', table: 't', key: ['id'], columns: ['id', 'status'], rows: [{ id: 'a', status: 'done' }] },
            { op: 'delete', table: 't', key: ['id'], columns: ['id'], rows: [{ id: 'b' }] },
        ]);
    });
});

/**
 * In-memory stand-in for an Elasticsearch cluster: records requests, keeps documents with sequence
 * numbers and emulates the store's update scripts (skip changes older than the document)
 */
class FakeElasticsearch implements ElasticsearchClientLike {
    docs = new Map<string, { source: Record<string, any>; seqNo: number }>();
    indices = {
        existing: new Set<string>(),
        created: [] as unknown[],
        exists: async ({ index }: { index: string }) => this.indices.existing.has(index),
        create: async (params: { index: string }) => {
            this.indices.created.push(params);
            this.indices.existing.add(params.index);
            return {};
        },
    };
    requests: Array<[string, any]> = [];
    private seqNo = 0;

    async bulk(params: { operations: any[] }) {
        this.requests.push(['bulk', params]);
        const items: Array<Record<string, { status: number; error?: unknown }>> = [];
        for (let i = 0; i < params.operations.length; i++) {
            const [action, meta] = Object.entries(params.operations[i])[0] as [string, any];
            const id = `${meta._index}/${meta._id}`;
            if (action === 'delete') {
                this.docs.delete(id);
                items.push({ delete: { status: 200 } });
                continue;
            }
            const body = params.operations[++i];
            const current = this.docs.get(id)?.source;
            if (!current) {
                this.docs.set(id, { source: structuredClone(body.upsert), seqNo: ++this.seqNo });
            } else if (!(current.es_tx > body.script.params.tx || (current.es_tx === body.script.params.tx && current.es_pos >= body.script.params.pos))) {
                if (body.script.params.doc) Object.assign(current, body.script.params.doc);
                for (const [field, value] of Object.entries<number>(body.script.params.values ?? {})) current[field] = (current[field] ?? 0) + value;
                Object.assign(current, { es_tx: body.script.params.tx, es_pos: body.script.params.pos });
            }
            items.push({ update: { status: 200 } });
        }
        return { items };
    }

    async get({ index, id }: { index: string; id: string }) {
        const doc = this.docs.get(`${index}/${id}`);
        if (!doc) throw Object.assign(new Error('not found'), { meta: { statusCode: 404 } });
        return { found: true, _source: structuredClone(doc.source), _seq_no: doc.seqNo, _primary_term: 1 };
    }

    async index(params: { index: string; id: string; document: any; op_type?: string; if_seq_no?: number }) {
        const id = `${params.index}/${params.id}`;
        const current = this.docs.get(id);
        if ((params.op_type === 'create' && current) || (params.if_seq_no !== undefined && current?.seqNo !== params.if_seq_no)) {
            throw Object.assign(new Error('version conflict'), { meta: { statusCode: 409 } });
        }
        this.docs.set(id, { source: structuredClone(params.document), seqNo: ++this.seqNo });
        return {};
    }

    async search(params: any) {
        this.requests.push(['search', params]);
        const hits = [...this.docs.entries()]
            .filter(([id]) => id.startsWith(`${params.index}/`))
            .map(([id, doc]) => ({ _id: id, _source: structuredClone(doc.source) }));
        return { hits: { total: { value: hits.length }, hits } };
    }

    async deleteByQuery(params: any) {
        this.requests.push(['deleteByQuery', params]);
        for (const id of this.docs.keys()) if (id.startsWith(`${params.index}/`)) this.docs.delete(id);
        return {};
    }
}

describe('ElasticsearchReadModelStore', () => {
    const orders: ReadModelCollection = {
        name: 'orders',
        search: { fields: ['title'] },
        elasticsearch: { mappings: { properties: { title: { type: 'text' } } } },
    };

    function setup() {
        const client = new FakeElasticsearch();
        return { client, store: new ElasticsearchReadModelStore(client, { indexPrefix: 'test-' }) };
    }

    it('creates indices with keyword strings and the given mappings on reset', async () => {
        const { client, store } = setup();
        client.indices.existing.add('test-existing');

        expect(await store.reset('p', 1, [orders, { name: 'existing' }])).toBe(true);

        expect(client.indices.created).toEqual([{
            index: 'test-orders',
            mappings: {
                dynamic_templates: [{ strings_as_keywords: { match_mapping_type: 'string', mapping: { type: 'keyword', ignore_above: 8191 } } }],
                properties: { id: { type: 'keyword' }, es_tx: { type: 'long' }, es_pos: { type: 'long' }, title: { type: 'text' } },
            },
            settings: undefined,
        }]);
        expect(client.requests).toEqual([['deleteByQuery', { index: 'test-existing', query: { match_all: {} }, refresh: true, conflicts: 'proceed' }]]);
        expect(await store.getCheckpoint('p')).toEqual({ version: 1, position: START_POSITION });
    });

    it('writes changes idempotently and moves the checkpoint with optimistic concurrency', async () => {
        const { client, store } = setup();
        await store.reset('p', 1, [orders]);
        const changes: ReadModelChange[] = [
            { op: 'upsert', collection: 'orders', key: { id: 'o1' }, row: { id: 'o1', title: 'Order', status: 'open' }, position: at(1) },
            { op: 'increment', collection: 'orders', key: { id: 'o1' }, values: { items: 2 }, position: at(2) },
            { op: 'upsert', collection: 'orders', key: { id: 'o1' }, row: { id: 'o1', status: 'paid' }, position: at(3) },
        ];

        expect(await store.commit({ projection: 'p', version: 1, expected: START_POSITION, next: at(3), changes })).toBe(true);
        expect(await store.get(orders, { id: 'o1' })).toEqual({ id: 'o1', title: 'Order', status: 'paid', items: 2 });

        // The same batch written again by a slower process: documents and checkpoint stay as they are
        await client.bulk({ operations: (client.requests[0][1] as { operations: unknown[] }).operations });
        expect(await store.get(orders, { id: 'o1' })).toEqual({ id: 'o1', title: 'Order', status: 'paid', items: 2 });
        expect(await store.commit({ projection: 'p', version: 1, expected: START_POSITION, next: at(3), changes })).toBe(false);
        expect(await store.getCheckpoint('p')).toEqual({ version: 1, position: at(3) });

        const [, bulk] = client.requests[0];
        expect(bulk.refresh).toBe('wait_for');
        expect(bulk.operations[0]).toEqual({ update: { _index: 'test-orders', _id: 'o1', retry_on_conflict: 3 } });
        expect(bulk.operations[1].upsert).toEqual({ id: 'o1', title: 'Order', status: 'open', es_tx: 7, es_pos: 1 });
    });

    it('translates queries to the query DSL and hides internal fields', async () => {
        const { client, store } = setup();
        await store.reset('p', 1, [orders]);
        await store.commit({
            projection: 'p', version: 1, expected: START_POSITION, next: at(1),
            changes: [{ op: 'upsert', collection: 'orders', key: { id: 'o1' }, row: { id: 'o1' }, position: at(1) }],
        });

        const page = await store.find(orders, {
            filter: { status: 'paid', total: { gte: 10, lt: 100 }, tag: { in: ['a', 'b'], neq: 'c' }, deleted_at: null },
            search: 'blue shoe',
            sort: [{ field: 'total', order: 'desc' }],
            limit: 20,
            offset: 40,
            count: true,
        });

        expect(page).toEqual({ items: [{ id: 'o1' }], total: 1 });
        expect(client.requests.at(-1)).toEqual(['search', {
            index: 'test-orders',
            query: {
                bool: {
                    filter: [
                        { term: { status: 'paid' } },
                        { range: { total: { gte: 10 } } },
                        { range: { total: { lt: 100 } } },
                        { terms: { tag: ['a', 'b'] } },
                    ],
                    must: [{ simple_query_string: { query: 'blue shoe', fields: ['title'], default_operator: 'and' } }],
                    must_not: [{ term: { tag: 'c' } }, { exists: { field: 'deleted_at' } }],
                },
            },
            sort: [{ total: { order: 'desc' } }],
            from: 40,
            size: 20,
            track_total_hits: true,
            ignore_unavailable: true,
        }]);
    });

    it('returns null for missing documents and fails on rejected changes', async () => {
        const { client, store } = setup();
        expect(await store.get(orders, { id: 'missing' })).toBeNull();
        expect(await store.getCheckpoint('p')).toBeNull();

        client.bulk = async () => ({ items: [{ update: { status: 400, error: { type: 'mapper_parsing_exception' } } }] });
        await expect(store.commit({
            projection: 'p', version: 1, expected: START_POSITION, next: at(1),
            changes: [{ op: 'upsert', collection: 'orders', key: { id: 'o1' }, row: { id: 'o1' }, position: at(1) }],
        })).rejects.toThrow(/mapper_parsing_exception/);
    });

    it('uses JSON arrays as ids of composite keys', async () => {
        const { client, store } = setup();
        await store.commit({
            projection: 'p', version: 1, expected: START_POSITION, next: at(1),
            changes: [{ op: 'delete', collection: 'lines', key: { order: 'o1', line: 2 }, position: at(1) }],
        });
        expect(client.requests[0][1].operations).toEqual([{ delete: { _index: 'test-lines', _id: '["o1",2]' } }]);
    });
});
