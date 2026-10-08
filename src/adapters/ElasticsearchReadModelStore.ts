import {
    comparePositions,
    DEFAULT_QUERY_LIMIT,
    EventStoreError,
    type FieldFilter,
    keyColumns,
    type Position,
    type ReadModelChange,
    type ReadModelCollection,
    type ReadModelPage,
    type ReadModelQuery,
    type ReadModelRow,
    START_POSITION,
} from "../domain/index.js";
import type {IReadModelStore, ProjectionCheckpoint, ProjectionCommit} from "../ports/index.js";

/**
 * Minimal subset of the Elasticsearch client API used by the read model store.
 *
 * The official client (`@elastic/elasticsearch` 8 or newer) satisfies it structurally, so it
 * does not have to be installed unless you actually use Elasticsearch.
 */
export interface ElasticsearchClientLike {
    bulk(params: { operations: unknown[]; refresh?: boolean | 'wait_for' }): Promise<{
        items: Array<Partial<Record<string, { status: number; error?: unknown }>>>;
    }>;
    get(params: { index: string; id: string }): Promise<{
        found: boolean;
        _source?: unknown;
        _seq_no?: number;
        _primary_term?: number;
    }>;
    index(params: {
        index: string;
        id: string;
        document: unknown;
        refresh?: boolean | 'wait_for';
        op_type?: 'create' | 'index';
        if_seq_no?: number;
        if_primary_term?: number;
    }): Promise<unknown>;
    search(params: {
        index: string;
        query?: any; // Query DSL (typed as `any` so the official client's request types are accepted)
        sort?: any;
        from?: number;
        size?: number;
        track_total_hits?: boolean;
        ignore_unavailable?: boolean;
    }): Promise<{
        hits: {
            total?: number | { value: number };
            hits: Array<{ _id?: string | null; _source?: unknown }>;
        };
    }>;
    deleteByQuery(params: { index: string; query: any; refresh?: boolean; conflicts?: 'abort' | 'proceed' }): Promise<unknown>;
    indices: {
        exists(params: { index: string }): Promise<boolean>;
        create(params: { index: string; mappings?: any; settings?: any }): Promise<unknown>;
    };
}

export interface ElasticsearchReadModelStoreOptions {
    indexPrefix?: string; // Prepended to collection names, e.g. 'prod-' (default: '')
    checkpointIndex?: string; // Index holding the projection checkpoints (default: 'eventstore-projections')
    /**
     * Refresh after each batch: `'wait_for'` (default) makes changes searchable before the commit
     * returns, which read-your-writes needs; `false` gives the highest indexing throughput.
     */
    refresh?: boolean | 'wait_for';
}

interface StoredCheckpoint {
    checkpoint: ProjectionCheckpoint;
    seqNo?: number;
    primaryTerm?: number;
}

// Position of the last event applied to a document: guards against applying older changes again
const POSITION_FIELDS = ['es_tx', 'es_pos'] as const;

const SKIP_OLDER = `
def s = ctx._source;
boolean older = false;
if (s.es_tx != null) {
  long tx = ((Number) s.es_tx).longValue();
  long pos = ((Number) s.es_pos).longValue();
  long ptx = ((Number) params.tx).longValue();
  long ppos = ((Number) params.pos).longValue();
  older = tx > ptx || (tx == ptx && pos >= ppos);
}`;

const UPSERT_SCRIPT = `${SKIP_OLDER}
if (older) { ctx.op = 'noop'; } else { s.putAll(params.doc); s.es_tx = params.tx; s.es_pos = params.pos; }`;

const INCREMENT_SCRIPT = `${SKIP_OLDER}
if (older) { ctx.op = 'noop'; } else {
  for (entry in params.values.entrySet()) {
    def value = s[entry.getKey()];
    s[entry.getKey()] = (value == null ? 0 : value) + entry.getValue();
  }
  s.es_tx = params.tx; s.es_pos = params.pos;
}`;

/**
 * Adapter: Elasticsearch Read Model Store
 *
 * Read models are indices; each row is a document whose id is its key. Elasticsearch has no
 * transactions, so changes are written idempotently instead: every document remembers the
 * position of the last event applied to it and older changes are skipped. A batch that is
 * written twice (after a crash, or by two processes) therefore has no further effect.
 * Deletes are not guarded: run one projector per Elasticsearch projection if it deletes.
 */
export class ElasticsearchReadModelStore implements IReadModelStore {
    private readonly prefix: string;
    private readonly checkpointIndex: string;
    private readonly refresh: boolean | 'wait_for';

    constructor(private readonly client: ElasticsearchClientLike, options: ElasticsearchReadModelStoreOptions = {}) {
        this.prefix = options.indexPrefix ?? '';
        this.checkpointIndex = options.checkpointIndex ?? 'eventstore-projections';
        this.refresh = options.refresh ?? 'wait_for';
    }

    async getCheckpoint(projection: string): Promise<ProjectionCheckpoint | null> {
        return (await this.readCheckpoint(projection))?.checkpoint ?? null;
    }

    async commit(commit: ProjectionCommit): Promise<boolean> {
        const stored = await this.readCheckpoint(commit.projection);
        const current = stored?.checkpoint ?? { version: commit.version, position: START_POSITION };
        if (current.version !== commit.version || comparePositions(current.position, commit.expected) !== 0) return false;

        if (commit.changes.length > 0) {
            const response = await this.client.bulk({
                operations: commit.changes.flatMap(change => this.operations(change)),
                refresh: this.refresh,
            });
            const failed = response.items.map(item => Object.values(item)[0]).find(result => result?.error);
            if (failed) throw new EventStoreError(`Elasticsearch rejected a read model change: ${JSON.stringify(failed.error)}`, failed.error);
        }

        return this.writeCheckpoint(commit.projection, { version: commit.version, position: commit.next }, stored);
    }

    async reset(projection: string, version: number, collections: readonly ReadModelCollection[], force = false): Promise<boolean> {
        const stored = await this.readCheckpoint(projection);
        if (stored && stored.checkpoint.version > version) return false;
        if (stored?.checkpoint.version === version && !force) return true;

        for (const collection of collections) {
            const index = this.indexName(collection.name);
            if (await this.client.indices.exists({ index })) {
                await this.client.deleteByQuery({ index, query: { match_all: {} }, refresh: true, conflicts: 'proceed' });
            } else {
                await this.client.indices.create({
                    index,
                    mappings: mappingsOf(collection),
                    settings: collection.elasticsearch?.settings,
                });
            }
        }

        return this.writeCheckpoint(projection, { version, position: START_POSITION }, stored);
    }

    async get<T = ReadModelRow>(collection: ReadModelCollection, key: ReadModelRow): Promise<T | null> {
        try {
            const response = await this.client.get({ index: this.indexName(collection.name), id: documentId(key) });
            return response.found ? withoutPosition(response._source) as T : null;
        } catch (err) {
            if (statusOf(err) === 404) return null;
            throw new EventStoreError(`Failed to read ${collection.name}: ${messageOf(err)}`, err);
        }
    }

    async find<T = ReadModelRow>(collection: ReadModelCollection, query: ReadModelQuery): Promise<ReadModelPage<T>> {
        const filter: unknown[] = [];
        const mustNot: unknown[] = [];
        const must: unknown[] = [];

        for (const [field, condition] of Object.entries(query.filter ?? {})) {
            for (const [operator, value] of conditions(condition)) {
                switch (operator) {
                    case 'eq': (value === null ? mustNot : filter).push(value === null ? { exists: { field } } : { term: { [field]: value } }); break;
                    case 'neq': (value === null ? filter : mustNot).push(value === null ? { exists: { field } } : { term: { [field]: value } }); break;
                    case 'in': filter.push({ terms: { [field]: value } }); break;
                    default: filter.push({ range: { [field]: { [operator]: value } } });
                }
            }
        }

        if (query.search) {
            must.push({
                simple_query_string: {
                    query: query.search,
                    fields: collection.search?.fields ?? ['*'],
                    default_operator: 'and',
                },
            });
        }

        try {
            const response = await this.client.search({
                index: this.indexName(collection.name),
                query: { bool: { filter, must, must_not: mustNot } },
                sort: query.sort?.map(({ field, order }) => ({ [field]: { order: order ?? 'asc' } })),
                from: query.offset ?? 0,
                size: query.limit ?? DEFAULT_QUERY_LIMIT,
                track_total_hits: query.count === true,
                ignore_unavailable: true,
            });

            const items = response.hits.hits.map(hit => withoutPosition(hit._source) as T);
            if (!query.count) return { items };

            const total = response.hits.total;
            return { items, total: typeof total === 'number' ? total : total?.value ?? items.length };
        } catch (err) {
            throw new EventStoreError(`Failed to query ${collection.name}: ${messageOf(err)}`, err);
        }
    }

    private operations(change: ReadModelChange): unknown[] {
        const target = { _index: this.indexName(change.collection), _id: documentId(change.key) };
        const params = toParams(change.position);

        switch (change.op) {
            case 'upsert':
                return [
                    { update: { ...target, retry_on_conflict: 3 } },
                    {
                        script: { source: UPSERT_SCRIPT, params: { ...params, doc: change.row } },
                        upsert: { ...change.row, es_tx: params.tx, es_pos: params.pos },
                    },
                ];
            case 'increment':
                return [
                    { update: { ...target, retry_on_conflict: 3 } },
                    {
                        script: { source: INCREMENT_SCRIPT, params: { ...params, values: change.values } },
                        upsert: { ...change.key, ...change.values, es_tx: params.tx, es_pos: params.pos },
                    },
                ];
            case 'delete':
                return [{ delete: target }];
        }
    }

    private async readCheckpoint(projection: string): Promise<StoredCheckpoint | null> {
        try {
            const response = await this.client.get({ index: this.checkpointIndex, id: projection });
            if (!response.found) return null;

            const source = response._source as { version: number; transaction_id: string; global_position: number };
            return {
                checkpoint: {
                    version: source.version,
                    position: { transactionId: String(source.transaction_id), globalPosition: Number(source.global_position) },
                },
                seqNo: response._seq_no,
                primaryTerm: response._primary_term,
            };
        } catch (err) {
            if (statusOf(err) === 404) return null;
            throw new EventStoreError(`Failed to read checkpoint of projection ${projection}: ${messageOf(err)}`, err);
        }
    }

    /**
     * Store a checkpoint unless it changed since it was read (optimistic concurrency control)
     */
    private async writeCheckpoint(projection: string, checkpoint: ProjectionCheckpoint, stored: StoredCheckpoint | null): Promise<boolean> {
        try {
            await this.client.index({
                index: this.checkpointIndex,
                id: projection,
                document: {
                    version: checkpoint.version,
                    transaction_id: checkpoint.position.transactionId,
                    global_position: checkpoint.position.globalPosition,
                    updated_at: new Date().toISOString(),
                },
                ...(stored?.seqNo !== undefined && stored.primaryTerm !== undefined
                    ? { if_seq_no: stored.seqNo, if_primary_term: stored.primaryTerm }
                    : { op_type: 'create' as const }),
            });
            return true;
        } catch (err) {
            if (statusOf(err) === 409) return false;
            throw new EventStoreError(`Failed to store checkpoint of projection ${projection}: ${messageOf(err)}`, err);
        }
    }

    private indexName(collection: string): string {
        return this.prefix + collection;
    }
}

/**
 * Document id of a key: the value of a single key column, or the JSON array of all key values
 */
export function documentId(key: ReadModelRow): string {
    const values = Object.values(key);
    return values.length === 1 ? String(values[0]) : JSON.stringify(values);
}

/**
 * Mappings for a new index: strings are keywords (exact filters and sorting work as with
 * PostgreSQL columns) unless the collection maps them differently, e.g. as `text` for search.
 */
function mappingsOf(collection: ReadModelCollection): Record<string, unknown> {
    const custom = collection.elasticsearch?.mappings ?? {};
    const keyProperties = Object.fromEntries(keyColumns(collection).map(column => [column, { type: 'keyword' }]));

    return {
        dynamic_templates: [{ strings_as_keywords: { match_mapping_type: 'string', mapping: { type: 'keyword', ignore_above: 8191 } } }],
        ...custom,
        properties: {
            ...keyProperties,
            es_tx: { type: 'long' },
            es_pos: { type: 'long' },
            ...(custom.properties as Record<string, unknown> | undefined),
        },
    };
}

function toParams(position: Position): { tx: number; pos: number } {
    return { tx: Number(position.transactionId), pos: position.globalPosition };
}

function withoutPosition(source: unknown): ReadModelRow {
    const row = { ...(source as ReadModelRow) };
    for (const field of POSITION_FIELDS) delete row[field];
    return row;
}

function conditions(filter: FieldFilter): Array<[string, unknown]> {
    if (filter === null || typeof filter !== 'object') return [['eq', filter]];
    return Object.entries(filter).filter(([, value]) => value !== undefined);
}

function statusOf(err: unknown): number | undefined {
    const error = err as { meta?: { statusCode?: number }; statusCode?: number } | undefined;
    return error?.meta?.statusCode ?? error?.statusCode;
}

function messageOf(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
