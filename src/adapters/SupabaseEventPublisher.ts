import {IEventPublisher} from "../ports";
import {SupabaseClient} from "@supabase/supabase-js";
import {EventRecord, QueryEventsOptions} from "../domain";

/**
 * Adapter: Supabase Event Publisher
 */
export class SupabaseEventPublisher implements IEventPublisher {
    private readonly tableName = 'events';

    constructor(private readonly client: SupabaseClient) {}

    subscribe(callback: (event: EventRecord) => void, filter?: QueryEventsOptions): () => void {
        const filterStr = this.buildRealtimeFilter(filter);

        const channel = this.client
            .channel('events-changes')
            .on(
                'postgres_changes',
                {
                    event: 'INSERT',
                    schema: 'public',
                    table: this.tableName,
                    filter: filterStr,
                },
                (payload) => callback(payload.new as EventRecord)
            )
            .subscribe();

        return () => channel.unsubscribe();
    }

    private buildRealtimeFilter(options?: QueryEventsOptions): string | undefined {
        if (!options) return undefined;

        const filters: string[] = [];
        if (options.aggregate_id) filters.push(`aggregate_id=eq.${options.aggregate_id}`);
        if (options.aggregate_type) filters.push(`aggregate_type=eq.${options.aggregate_type}`);
        if (options.type) filters.push(`type=eq.${options.type}`);

        return filters.length > 0 ? filters.join(',') : undefined;
    }
}