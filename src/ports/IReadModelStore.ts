import type {Position, ReadModelChange, ReadModelCollection, ReadModelPage, ReadModelQuery, ReadModelRow} from "../domain/index.js";

/**
 * Stored progress of a projection
 */
export interface ProjectionCheckpoint {
    version: number;
    position: Position;
}

/**
 * A batch of read model changes and the checkpoint move that goes with it
 */
export interface ProjectionCommit {
    projection: string;
    version: number;
    expected: Position; // Checkpoint the batch was read from
    next: Position; // Checkpoint after the batch
    changes: ReadModelChange[];
}

/**
 * Port: Read Model Store
 * Defines contract for storing and querying read models (tables, search indices)
 */
export interface IReadModelStore {
    getCheckpoint(projection: string): Promise<ProjectionCheckpoint | null>;
    /**
     * Apply the changes and move the checkpoint from `expected` to `next`. Resolves to false
     * without applying anything if the stored checkpoint is not at `expected` with `version`
     * (another process got there first). Stores without transactions must apply changes so
     * that applying a batch again has no further effect.
     */
    commit(commit: ProjectionCommit): Promise<boolean>;
    /**
     * Empty the collections and set the checkpoint to the start with `version`. Resolves to false
     * without changing anything if the stored version is newer. Without `force`, a projection
     * already stored with `version` is left as it is (another process initialized it first).
     */
    reset(projection: string, version: number, collections: readonly ReadModelCollection[], force?: boolean): Promise<boolean>;
    get<T = ReadModelRow>(collection: ReadModelCollection, key: ReadModelRow): Promise<T | null>;
    find<T = ReadModelRow>(collection: ReadModelCollection, query: ReadModelQuery): Promise<ReadModelPage<T>>;
}
