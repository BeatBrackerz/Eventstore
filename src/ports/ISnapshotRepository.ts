import {CreateSnapshotInput, SnapshotRecord} from "../domain";

/**
 * Port: Snapshot Repository
 * Defines contract for snapshot persistence
 */
export interface ISnapshotRepository {
    saveSnapshot(snapshot: CreateSnapshotInput): Promise<SnapshotRecord>;
    findLatestSnapshot(aggregateId: string, aggregateType: string): Promise<SnapshotRecord | null>;
    findSnapshotAtSequence(aggregateId: string, aggregateType: string, sequenceNumber: number): Promise<SnapshotRecord | null>;
    deleteOldSnapshots(aggregateId: string, aggregateType: string, keepCount: number): Promise<number>;
}