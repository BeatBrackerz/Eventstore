import type {ISequenceRepository} from "../ports/index.js";
import {EventStoreError} from "../domain/index.js";
import type {AnySupabaseClient} from "./supabaseSupport.js";

/**
 * Adapter: Supabase Sequence Repository
 *
 * Fallback used when the `es_append_events` database function is not installed. Reading and
 * updating the counter are separate requests, so concurrent writers to the same aggregate can
 * race; the database function allocates sequence numbers atomically instead.
 */
export class SupabaseSequenceRepository implements ISequenceRepository {
    private readonly tableName = 'aggregate_sequences';

    constructor(private readonly client: AnySupabaseClient) {}

    async getCurrentSequence(aggregateId: string, aggregateType: string): Promise<number> {
        const { data, error } = await this.client
            .from(this.tableName)
            .select('last_sequence')
            .eq('aggregate_id', aggregateId)
            .eq('aggregate_type', aggregateType)
            .maybeSingle();

        if (error) throw new EventStoreError(`Failed to get sequence: ${error.message}`, error);
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
