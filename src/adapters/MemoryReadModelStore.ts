import {
    applyChange,
    comparePositions,
    DEFAULT_QUERY_LIMIT,
    type FieldFilter,
    type FilterValue,
    keyId,
    type ReadModelCollection,
    type ReadModelPage,
    type ReadModelQuery,
    type ReadModelRow,
    START_POSITION,
} from "../domain/index.js";
import type {IReadModelStore, ProjectionCheckpoint, ProjectionCommit} from "../ports/index.js";

/**
 * Adapter: In-Memory Read Model Store
 *
 * Keeps read models in this process – for tests, development and read models that are cheap to
 * rebuild on startup. Commits are atomic. Every read returns copies.
 */
export class MemoryReadModelStore implements IReadModelStore {
    private readonly collections = new Map<string, Map<string, ReadModelRow>>();
    private readonly checkpoints = new Map<string, ProjectionCheckpoint>();

    async getCheckpoint(projection: string): Promise<ProjectionCheckpoint | null> {
        return structuredClone(this.checkpoints.get(projection) ?? null);
    }

    async commit(commit: ProjectionCommit): Promise<boolean> {
        const current = this.checkpoints.get(commit.projection) ?? { version: commit.version, position: START_POSITION };
        if (current.version !== commit.version || comparePositions(current.position, commit.expected) !== 0) return false;

        for (const change of commit.changes) {
            const rows = this.rows(change.collection);
            const id = keyId(change.key);
            const row = applyChange(rows.get(id) ?? null, change);
            if (row) rows.set(id, row);
            else rows.delete(id);
        }

        this.checkpoints.set(commit.projection, { version: commit.version, position: { ...commit.next } });
        return true;
    }

    async reset(projection: string, version: number, collections: readonly ReadModelCollection[], force = false): Promise<boolean> {
        const current = this.checkpoints.get(projection);
        if (current && current.version > version) return false;
        if (current?.version === version && !force) return true;

        for (const collection of collections) this.collections.delete(collection.name);
        this.checkpoints.set(projection, { version, position: START_POSITION });
        return true;
    }

    async get<T = ReadModelRow>(collection: ReadModelCollection, key: ReadModelRow): Promise<T | null> {
        return structuredClone((this.collections.get(collection.name)?.get(keyId(key)) ?? null) as T | null);
    }

    async find<T = ReadModelRow>(collection: ReadModelCollection, query: ReadModelQuery): Promise<ReadModelPage<T>> {
        let rows = Array.from(this.collections.get(collection.name)?.values() ?? []);

        for (const [field, filter] of Object.entries(query.filter ?? {})) {
            rows = rows.filter(row => matches(row[field], filter));
        }

        if (query.search) {
            const terms = query.search.toLowerCase().split(/\s+/).filter(Boolean);
            const fields = collection.search?.fields;
            rows = rows.filter(row => {
                const text = (fields ?? Object.keys(row)).map(field => row[field])
                    .filter(value => typeof value === 'string').join(' ').toLowerCase();
                return terms.every(term => text.includes(term));
            });
        }

        const sort = query.sort ?? [];
        if (sort.length > 0) {
            rows.sort((a, b) => {
                for (const { field, order } of sort) {
                    const result = compareValues(a[field], b[field]);
                    if (result !== 0) return order === 'desc' ? -result : result;
                }
                return 0;
            });
        }

        const offset = query.offset ?? 0;
        const items = rows.slice(offset, offset + (query.limit ?? DEFAULT_QUERY_LIMIT));
        return { items: structuredClone(items) as T[], ...(query.count ? { total: rows.length } : {}) };
    }

    /** Number of rows in a collection */
    size(collection: string): number {
        return this.collections.get(collection)?.size ?? 0;
    }

    private rows(collection: string): Map<string, ReadModelRow> {
        let rows = this.collections.get(collection);
        if (!rows) {
            rows = new Map();
            this.collections.set(collection, rows);
        }
        return rows;
    }
}

function matches(value: unknown, filter: FieldFilter): boolean {
    if (filter === null || typeof filter !== 'object') return equals(value, filter);

    return (filter.eq === undefined || equals(value, filter.eq))
        && (filter.neq === undefined || !equals(value, filter.neq))
        && (filter.gt === undefined || (value != null && compareValues(value, filter.gt) > 0))
        && (filter.gte === undefined || (value != null && compareValues(value, filter.gte) >= 0))
        && (filter.lt === undefined || (value != null && compareValues(value, filter.lt) < 0))
        && (filter.lte === undefined || (value != null && compareValues(value, filter.lte) <= 0))
        && (filter.in === undefined || filter.in.some(candidate => equals(value, candidate)));
}

function equals(value: unknown, expected: FilterValue): boolean {
    return expected === null ? value === null || value === undefined : value === expected;
}

// Missing values sort last, as NULLs do in PostgreSQL
function compareValues(a: unknown, b: unknown): number {
    if (a == null || b == null) return a == null ? (b == null ? 0 : 1) : -1;
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}
