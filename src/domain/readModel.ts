import type {EventRecord} from "./event.js";
import {EventStoreError} from "./event.js";

/**
 * Position in the global event log, in commit order.
 *
 * Events are ordered by the id of the transaction that wrote them, then by their global
 * position (see `es_read_all` in sql/eventstore.sql). Both come from the columns
 * `transaction_id` and `global_position` of the events table.
 */
export interface Position {
    transactionId: string; // Decimal string: PostgreSQL transaction ids are 64-bit
    globalPosition: number;
}

/** Position before the first event */
export const START_POSITION: Position = Object.freeze({ transactionId: '0', globalPosition: 0 });

/**
 * Negative if `a` comes before `b`, positive if after, 0 if equal
 */
export function comparePositions(a: Position, b: Position): number {
    const ta = BigInt(a.transactionId);
    const tb = BigInt(b.transactionId);
    if (ta !== tb) return ta < tb ? -1 : 1;
    return a.globalPosition - b.globalPosition;
}

/**
 * Position of a stored event, or undefined if the events table has no position columns yet
 */
export function positionOf(event: EventRecord): Position | undefined {
    if (event.transaction_id == null || event.global_position == null) return undefined;
    return { transactionId: String(event.transaction_id), globalPosition: Number(event.global_position) };
}

/**
 * Latest position of the given events (undefined if none has a position)
 */
export function latestPosition(events: readonly EventRecord[]): Position | undefined {
    let latest: Position | undefined;
    for (const event of events) {
        const position = positionOf(event);
        if (position && (!latest || comparePositions(position, latest) > 0)) latest = position;
    }
    return latest;
}

/**
 * A read model collection: a table (Supabase/PostgreSQL) or an index (Elasticsearch)
 */
export interface ReadModelCollection {
    name: string;
    /** Key column(s); upserts and increments match existing rows by them (default: 'id') */
    key?: string | readonly string[];
    /** Full-text search used by `ReadModelQuery.search` */
    search?: {
        column?: string; // PostgreSQL: tsvector (or text) column searched with websearch_to_tsquery
        config?: string; // PostgreSQL: text search configuration, e.g. 'german'
        fields?: readonly string[]; // Elasticsearch and in-memory store: fields to search (default: all)
    };
    /** Elasticsearch: index mappings and settings used when the store creates the index */
    elasticsearch?: {
        mappings?: Record<string, unknown>;
        settings?: Record<string, unknown>;
    };
}

/** Key of a read model row: the value of a single key column, or an object with all key columns */
export type ReadModelKey = string | number | Readonly<Record<string, unknown>>;

export type ReadModelRow = Record<string, unknown>;

/**
 * A change to a read model, as collected while a projection handles events. `key` holds the
 * key columns in the order the collection declares them; `position` is the event's position and
 * `ordinal` the index of the change among the changes made for that event.
 */
export type ReadModelChange = { collection: string; key: ReadModelRow; position: Position; ordinal?: number } & (
    | { op: 'upsert'; row: ReadModelRow }
    | { op: 'increment'; values: Record<string, number> }
    | { op: 'delete' }
);

/**
 * What a projection handler can do with its read models. Changes are collected and stored
 * together with the projection's checkpoint after the batch of events has been handled.
 */
export interface ProjectionContext {
    /** Insert a row, or update the given columns of an existing one (other columns, and columns set to undefined, keep their values) */
    upsert(collection: string, row: ReadModelRow): void;
    /** Add to numeric columns of a row; a missing row is inserted with the values as initial values */
    increment(collection: string, key: ReadModelKey, values: Record<string, number>): void;
    /** Delete a row */
    delete(collection: string, key: ReadModelKey): void;
    /** Current row, including changes made earlier in this batch */
    get<T extends ReadModelRow = ReadModelRow>(collection: string, key: ReadModelKey): Promise<T | null>;
}

export type FilterValue = string | number | boolean | null;

/** A value (equality) or operators that all have to match */
export type FieldFilter = FilterValue | {
    eq?: FilterValue;
    neq?: FilterValue;
    gt?: string | number;
    gte?: string | number;
    lt?: string | number;
    lte?: string | number;
    in?: readonly FilterValue[];
};

/**
 * Store-independent query of a read model collection
 */
export interface ReadModelQuery {
    filter?: Readonly<Record<string, FieldFilter>>;
    search?: string; // Full-text search, see ReadModelCollection.search
    sort?: ReadonlyArray<{ field: string; order?: 'asc' | 'desc' }>;
    limit?: number; // Default: 100
    offset?: number;
    count?: boolean; // Also return the total number of matches
}

export interface ReadModelPage<T> {
    items: T[];
    total?: number; // Only with `count: true`
}

export const DEFAULT_QUERY_LIMIT = 100;

/** Key columns of a collection */
export function keyColumns(collection: ReadModelCollection): readonly string[] {
    const key = collection.key ?? 'id';
    return typeof key === 'string' ? [key] : key;
}

/**
 * Normalize a key to an object with the collection's key columns, in declaration order
 */
export function normalizeKey(collection: ReadModelCollection, key: ReadModelKey): ReadModelRow {
    const columns = keyColumns(collection);

    if (typeof key !== 'object' || key === null) {
        if (columns.length !== 1) {
            throw new EventStoreError(`Collection ${collection.name} has a composite key (${columns.join(', ')}): pass an object`);
        }
        return { [columns[0]]: key };
    }

    const normalized: ReadModelRow = {};
    for (const column of columns) {
        if (key[column] === undefined || key[column] === null) {
            throw new EventStoreError(`Key column ${column} of collection ${collection.name} is missing`);
        }
        normalized[column] = key[column];
    }
    return normalized;
}

/** String identifying a normalized key, for maps */
export function keyId(key: ReadModelRow): string {
    return JSON.stringify(Object.values(key));
}

/**
 * A row after applying a change to it (null: deleted or missing). Does not modify `row`.
 */
export function applyChange(row: ReadModelRow | null, change: ReadModelChange): ReadModelRow | null {
    switch (change.op) {
        case 'upsert':
            return { ...row, ...structuredClone(change.row) };
        case 'increment': {
            const next: ReadModelRow = { ...(row ?? change.key) };
            for (const [column, value] of Object.entries(change.values)) {
                next[column] = Number(next[column] ?? 0) + value;
            }
            return next;
        }
        case 'delete':
            return null;
    }
}
