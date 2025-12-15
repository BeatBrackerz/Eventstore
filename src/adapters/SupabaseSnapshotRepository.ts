import {ISnapshotRepository} from "../ports";
import {SupabaseClient} from "@supabase/supabase-js";
import {CreateSnapshotInput, EventStoreError, SnapshotRecord} from "../domain";

/**
 * Adapter: Supabase Snapshot Repository
 */
export class SupabaseSnapshotRepository implements ISnapshotRepository {
    private readonly tableName = 'snapshots';

    constructor(private readonly client: SupabaseClient) {}

    async saveSnapshot(snapshot: CreateSnapshotInput): Promise<SnapshotRecord> {
        const { data, error } = await this.client
            .from(this.tableName)
            .insert({
                aggregate_id: snapshot.aggregate_id,
                aggregate_type: snapshot.aggregate_type,
                sequence_number: snapshot.sequence_number,
                state: snapshot.state,
                version: snapshot.version ?? 1,
            })
            .select()
            .single();

        if (error) throw new EventStoreError(`Failed to save snapshot: ${error.message}`, error);
        return data as SnapshotRecord;
    }

    async findLatestSnapshot(aggregateId: string, aggregateType: string): Promise<SnapshotRecord | null> {
        const { data, error } = await this.client
            .from(this.tableName)
            .select('*')
            .eq('aggregate_id', aggregateId)
            .eq('aggregate_type', aggregateType)
            .order('sequence_number', { ascending: false })
            .limit(1)
            .single();

        if (error && error.code !== 'PGRST116') {
            throw new EventStoreError(`Failed to find snapshot: ${error.message}`, error);
        }

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
            .single();

        if (error && error.code !== 'PGRST116') {
            throw new EventStoreError(`Failed to find snapshot: ${error.message}`, error);
        }

        return (data as SnapshotRecord) ?? null;
    }

    async deleteOldSnapshots(aggregateId: string, aggregateType: string, keepCount: number): Promise<number> {
        const { data: snapshots } = await this.client
            .from(this.tableName)
            .select('id, sequence_number')
            .eq('aggregate_id', aggregateId)
            .eq('aggregate_type', aggregateType)
            .order('sequence_number', { ascending: false });

        if (!snapshots || snapshots.length <= keepCount) return 0;

        const toDelete = snapshots.slice(keepCount);
        const idsToDelete = toDelete.map(s => s.id);

        const { error } = await this.client
            .from(this.tableName)
            .delete()
            .in('id', idsToDelete);

        if (error) throw new EventStoreError(`Failed to delete snapshots: ${error.message}`, error);
        return toDelete.length;
    }
}