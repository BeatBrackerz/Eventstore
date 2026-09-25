import type {ISnapshotRepository} from "../ports/index.js";
import {CreateSnapshotInput, EventStoreError, SnapshotRecord} from "../domain/index.js";
import type {AnySupabaseClient, SupabaseAdapterOptions} from "./supabaseSupport.js";

/**
 * Adapter: Supabase Snapshot Repository
 */
export class SupabaseSnapshotRepository implements ISnapshotRepository {
    private readonly tableName = 'snapshots';

    // Options are accepted for symmetry with the other adapters
    constructor(private readonly client: AnySupabaseClient, _options: SupabaseAdapterOptions = {}) {}

    async saveSnapshot(snapshot: CreateSnapshotInput): Promise<SnapshotRecord> {
        const { data, error } = await this.client
            .from(this.tableName)
            .insert(toRow(snapshot))
            .select()
            .single();

        if (error) throw new EventStoreError(`Failed to save snapshot: ${error.message}`, error);
        return data as SnapshotRecord;
    }

    async saveSnapshots(snapshots: CreateSnapshotInput[]): Promise<SnapshotRecord[]> {
        if (snapshots.length === 0) return [];

        const { data, error } = await this.client
            .from(this.tableName)
            .insert(snapshots.map(toRow))
            .select();

        if (error) throw new EventStoreError(`Failed to save snapshots: ${error.message}`, error);
        return data as SnapshotRecord[];
    }

    async findLatestSnapshot(aggregateId: string, aggregateType: string): Promise<SnapshotRecord | null> {
        const { data, error } = await this.client
            .from(this.tableName)
            .select('*')
            .eq('aggregate_id', aggregateId)
            .eq('aggregate_type', aggregateType)
            .order('sequence_number', { ascending: false })
            .limit(1)
            .maybeSingle();

        if (error) throw new EventStoreError(`Failed to find snapshot: ${error.message}`, error);
        return (data as SnapshotRecord) ?? null;
    }

    async findLatestSnapshotAfter(aggregateId: string, aggregateType: string, afterSequence: number): Promise<SnapshotRecord | null> {
        const { data, error } = await this.client
            .from(this.tableName)
            .select('*')
            .eq('aggregate_id', aggregateId)
            .eq('aggregate_type', aggregateType)
            .gt('sequence_number', afterSequence)
            .order('sequence_number', { ascending: false })
            .limit(1)
            .maybeSingle();

        if (error) throw new EventStoreError(`Failed to find snapshot: ${error.message}`, error);
        return (data as SnapshotRecord) ?? null;
    }

    async findSnapshotAtSequence(aggregateId: string, aggregateType: string, sequenceNumber: number): Promise<SnapshotRecord | null> {
        const { data, error } = await this.client
            .from(this.tableName)
            .select('*')
            .eq('aggregate_id', aggregateId)
            .eq('aggregate_type', aggregateType)
            .lte('sequence_number', sequenceNumber)
            .order('sequence_number', { ascending: false })
            .limit(1)
            .maybeSingle();

        if (error) throw new EventStoreError(`Failed to find snapshot: ${error.message}`, error);
        return (data as SnapshotRecord) ?? null;
    }

    /**
     * Delete all but the `keepCount` most recent snapshots with at most two requests,
     * regardless of how many snapshots exist.
     */
    async deleteOldSnapshots(aggregateId: string, aggregateType: string, keepCount: number): Promise<number> {
        let query = this.client
            .from(this.tableName)
            .delete({ count: 'exact' })
            .eq('aggregate_id', aggregateId)
            .eq('aggregate_type', aggregateType);

        if (keepCount > 0) {
            // The oldest snapshot to keep; everything ordered after it gets deleted
            const { data: boundary, error } = await this.client
                .from(this.tableName)
                .select('id, sequence_number')
                .eq('aggregate_id', aggregateId)
                .eq('aggregate_type', aggregateType)
                .order('sequence_number', { ascending: false })
                .order('id', { ascending: false })
                .range(keepCount - 1, keepCount - 1)
                .maybeSingle();

            if (error) throw new EventStoreError(`Failed to find snapshots: ${error.message}`, error);
            if (!boundary) return 0;

            query = query.or(
                `sequence_number.lt.${boundary.sequence_number},` +
                `and(sequence_number.eq.${boundary.sequence_number},id.lt."${boundary.id}")`
            );
        }

        const { count, error } = await query;

        if (error) throw new EventStoreError(`Failed to delete snapshots: ${error.message}`, error);
        return count ?? 0;
    }
}

function toRow(snapshot: CreateSnapshotInput) {
    return {
        aggregate_id: snapshot.aggregate_id,
        aggregate_type: snapshot.aggregate_type,
        sequence_number: snapshot.sequence_number,
        state: snapshot.state,
        version: snapshot.version ?? 1,
    };
}
