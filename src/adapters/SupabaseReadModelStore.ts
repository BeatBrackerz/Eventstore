import {
    DEFAULT_QUERY_LIMIT,
    EventStoreError,
    type FieldFilter,
    keyId,
    type ReadModelChange,
    type ReadModelCollection,
    type ReadModelPage,
    type ReadModelQuery,
    type ReadModelRow,
} from "../domain/index.js";
import type {IReadModelStore, ProjectionCheckpoint, ProjectionCommit} from "../ports/index.js";
import {type AnySupabaseClient, DEFAULT_PAGE_SIZE, RpcSupport} from "./supabaseSupport.js";

export interface SupabaseReadModelStoreOptions {
    /** Rows per request when a query asks for more; must not exceed PostgREST's max-rows (default: 1000) */
    pageSize?: number;
}

/** One statement of `es_project`: rows with the same columns and distinct keys */
export interface ProjectStatement {
    op: ReadModelChange['op'];
    table: string;
    key: string[];
    columns: string[];
    rows: ReadModelRow[];
}

/**
 * Adapter: Supabase Read Model Store
 *
 * Read models are ordinary tables in the public schema – query them with this store, with
 * supabase-js, from the browser under row level security, or join them in SQL. Every batch of
 * changes is written in one request together with the projection's checkpoint (`es_project`),
 * in one transaction: each batch is applied exactly once.
 */
export class SupabaseReadModelStore implements IReadModelStore {
    private readonly rpc: RpcSupport;
    private readonly pageSize: number;

    constructor(private readonly client: AnySupabaseClient, options: SupabaseReadModelStoreOptions = {}) {
        // Projections cannot work without the database functions, so they are required
        this.rpc = new RpcSupport(client, true);
        this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    }

    async getCheckpoint(projection: string): Promise<ProjectionCheckpoint | null> {
        const { data, error } = await this.client
            .from('es_projections')
            .select('version, transaction_id, global_position')
            .eq('name', projection)
            .maybeSingle();

        if (error) throw new EventStoreError(`Failed to read checkpoint of projection ${projection}: ${error.message}${missingSchemaHint(error)}`, error);
        if (!data) return null;

        return {
            version: Number(data.version),
            position: { transactionId: String(data.transaction_id), globalPosition: Number(data.global_position) },
        };
    }

    async commit(commit: ProjectionCommit): Promise<boolean> {
        const committed = await this.rpc.call<boolean>('es_project', {
            p_projection: commit.projection,
            p_version: commit.version,
            p_expected_transaction_id: commit.expected.transactionId,
            p_expected_position: commit.expected.globalPosition,
            p_transaction_id: commit.next.transactionId,
            p_position: commit.next.globalPosition,
            p_changes: toStatements(commit.changes),
        });
        return committed === true;
    }

    async reset(projection: string, version: number, collections: readonly ReadModelCollection[], force = false): Promise<boolean> {
        const reset = await this.rpc.call<boolean>('es_reset_projection', {
            p_projection: projection,
            p_version: version,
            p_tables: collections.map(collection => collection.name),
            p_force: force,
        });
        return reset === true;
    }

    async get<T = ReadModelRow>(collection: ReadModelCollection, key: ReadModelRow): Promise<T | null> {
        const { data, error } = await this.client.from(collection.name).select('*').match(key).maybeSingle();
        if (error) throw new EventStoreError(`Failed to read ${collection.name}: ${error.message}`, error);
        return (data as T) ?? null;
    }

    /**
     * Rows matching the query. Limits above the page size are fetched page by page.
     */
    async find<T = ReadModelRow>(collection: ReadModelCollection, query: ReadModelQuery): Promise<ReadModelPage<T>> {
        const limit = query.limit ?? DEFAULT_QUERY_LIMIT;
        const items: T[] = [];
        let total: number | undefined;

        for (let offset = query.offset ?? 0; items.length < limit;) {
            const size = Math.min(this.pageSize, limit - items.length);
            const withCount = query.count === true && total === undefined;
            const { data, error, count } = await this.select(collection, query, withCount).range(offset, offset + size - 1);

            if (error) throw new EventStoreError(`Failed to query ${collection.name}: ${error.message}`, error);
            if (withCount) total = count ?? 0;

            const page = (data ?? []) as T[];
            for (const row of page) items.push(row);
            offset += page.length;
            if (page.length < size) break;
        }

        return query.count ? { items, total: total ?? items.length } : { items };
    }

    private select(collection: ReadModelCollection, query: ReadModelQuery, withCount: boolean) {
        let builder = this.client.from(collection.name).select('*', withCount ? { count: 'exact' } : undefined);

        for (const [field, filter] of Object.entries(query.filter ?? {})) {
            for (const [operator, value] of conditions(filter)) {
                switch (operator) {
                    case 'eq': builder = value === null ? builder.is(field, null) : builder.eq(field, value); break;
                    case 'neq': builder = value === null ? builder.not(field, 'is', null) : builder.neq(field, value); break;
                    case 'gt': builder = builder.gt(field, value); break;
                    case 'gte': builder = builder.gte(field, value); break;
                    case 'lt': builder = builder.lt(field, value); break;
                    case 'lte': builder = builder.lte(field, value); break;
                    case 'in': builder = builder.in(field, value as unknown[]); break;
                }
            }
        }

        if (query.search) {
            const column = collection.search?.column;
            if (!column) throw new EventStoreError(`Collection ${collection.name} has no search column (search.column)`);
            builder = builder.textSearch(column, query.search, { type: 'websearch', config: collection.search?.config });
        }

        for (const { field, order } of query.sort ?? []) {
            builder = builder.order(field, { ascending: order !== 'desc' });
        }

        return builder;
    }
}

/**
 * Group changes into as few statements as possible while keeping their order: consecutive
 * changes of the same kind, table and columns form one statement. Changes to a row already in
 * the statement are merged into it (later upsert values win, increments add up).
 */
export function toStatements(changes: readonly ReadModelChange[]): ProjectStatement[] {
    const statements: ProjectStatement[] = [];
    let current: { statement: ProjectStatement; signature: string; rows: Map<string, number> } | undefined;

    for (const change of changes) {
        const key = Object.keys(change.key);
        const row = change.op === 'upsert' ? { ...change.row }
            : change.op === 'increment' ? { ...change.key, ...change.values }
                : { ...change.key };
        const columns = Object.keys(row).sort();
        const signature = JSON.stringify([change.op, change.collection, key, columns]);
        const id = keyId(change.key);

        if (current?.signature === signature) {
            const index = current.rows.get(id);
            if (index === undefined) {
                current.rows.set(id, current.statement.rows.length);
                current.statement.rows.push(row);
                continue;
            }
            if (change.op === 'upsert') {
                current.statement.rows[index] = row;
                continue;
            }
            if (change.op === 'increment') {
                const merged = current.statement.rows[index];
                for (const [column, value] of Object.entries(change.values)) merged[column] = Number(merged[column]) + value;
                continue;
            }
            continue; // Deleting the same row twice
        }

        const statement: ProjectStatement = { op: change.op, table: change.collection, key, columns, rows: [row] };
        current = { statement, signature, rows: new Map([[id, 0]]) };
        statements.push(statement);
    }

    return statements;
}

function conditions(filter: FieldFilter): Array<[string, unknown]> {
    if (filter === null || typeof filter !== 'object') return [['eq', filter]];
    return Object.entries(filter).filter(([, value]) => value !== undefined);
}

function missingSchemaHint(error: { code?: string }): string {
    // PGRST205: table not in PostgREST's schema cache, 42P01: undefined_table
    return error.code === 'PGRST205' || error.code === '42P01' ? ' (run sql/eventstore.sql)' : '';
}
