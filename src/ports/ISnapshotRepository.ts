import type {CreateSnapshotInput, SnapshotRecord} from "../domain/index.js";

/**
 * Port: Snapshot Repository
 * Defines contract for snapshot persistence
 */
export interface ISnapshotRepository {
    saveSnapshot(snapshot: CreateSnapshotInput): Promise<SnapshotRecord>;
    findLatestSnapshot(aggregateId: string, aggregateType: string): Promise<SnapshotRecord | null>;
    findSnapshotAtSequence(aggregateId: string, aggregateType: string, sequenceNumber: number): Promise<SnapshotRecord | null>;
    deleteOldSnapshots(aggregateId: string, aggregateType: string, keepCount: number): Promise<number>;

    /** Optional: store several snapshots in one call. */
    saveSnapshots?(snapshots: CreateSnapshotInput[]): Promise<SnapshotRecord[]>;
    /** Optional: latest snapshot with a sequence number greater than `afterSequence`, or null. */
    findLatestSnapshotAfter?(aggregateId: string, aggregateType: string, afterSequence: number): Promise<SnapshotRecord | null>;
}
