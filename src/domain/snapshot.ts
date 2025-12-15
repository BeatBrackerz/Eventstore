/**
 * Snapshot record as stored in database
 */
export interface SnapshotRecord {
    id: string;
    aggregate_id: string;
    aggregate_type: string;
    sequence_number: number;
    state: any;
    version: number;
    created_at: string;
}

/**
 * Create snapshot input
 */
export interface CreateSnapshotInput {
    aggregate_id: string;
    aggregate_type: string;
    sequence_number: number;
    state: any;
    version?: number;
}