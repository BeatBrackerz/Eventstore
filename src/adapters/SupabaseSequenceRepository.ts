import {ISequenceRepository} from "../ports";
import {SupabaseClient} from "@supabase/supabase-js";
import {EventStoreError} from "../domain";

/**
 * Adapter: Supabase Sequence Repository
 */
export class SupabaseSequenceRepository implements ISequenceRepository {
    private readonly tableName = 'aggregate_sequences';

    constructor(private readonly client: SupabaseClient) {}

    async getCurrentSequence(aggregateId: string, aggregateType: string): Promise<number> {
        const { data, error } = await this.client
            .from(this.tableName)
            .select('last_sequence')
            .eq('aggregate_id', aggregateId)
            .eq('aggregate_type', aggregateType)
            .single();

        if (error && error.code !== 'PGRST116') {
            throw new EventStoreError(`Failed to get sequence: ${error.message}`, error);
        }

        return data?.last_sequence ?? 0;
    }

    async getNextSequence(aggregateId: string, aggregateType: string, count: number = 1): Promise<number> {
        const current = await this.getCurrentSequence(aggregateId, aggregateType);
        const next = current + count;

        const { error } = await this.client
            .from(this.tableName)
            .upsert({
                aggregate_id: aggregateId,
                aggregate_type: aggregateType,
                last_sequence: next,
            });

        if (error) throw new EventStoreError(`Failed to update sequence: ${error.message}`, error);
        return current + 1;
    }
}