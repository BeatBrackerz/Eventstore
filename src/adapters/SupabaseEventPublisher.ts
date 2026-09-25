import type {IEventPublisher} from "../ports/index.js";
import type {EventRecord, QueryEventsOptions} from "../domain/index.js";
import type {AnySupabaseClient} from "./supabaseSupport.js";

let subscriptionCounter = 0;

/**
 * Adapter: Supabase Event Publisher
 */
export class SupabaseEventPublisher implements IEventPublisher {
    private readonly tableName = 'events';

    constructor(private readonly client: AnySupabaseClient) {}

    subscribe(callback: (event: EventRecord) => void, filter?: QueryEventsOptions): () => void {
        const filterStr = this.buildRealtimeFilter(filter);

        // Every subscription needs its own channel: supabase-js returns the existing channel for a
        // known topic, and listeners cannot be added to a channel that is already subscribed.
        const topic = `events-changes-${++subscriptionCounter}-${Math.random().toString(36).slice(2, 10)}`;

        const channel = this.client
            .channel(topic)
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

        return () => {
            void this.client.removeChannel(channel);
        };
    }

    private buildRealtimeFilter(options?: QueryEventsOptions): string | undefined {
        if (!options) return undefined;

        // Conditions separated by commas are combined with AND by the Realtime server
        const filters: string[] = [];
        if (options.aggregate_id) filters.push(`aggregate_id=eq.${quoteFilterValue(options.aggregate_id)}`);
        if (options.aggregate_type) filters.push(`aggregate_type=eq.${quoteFilterValue(options.aggregate_type)}`);
        if (options.type) filters.push(`type=eq.${quoteFilterValue(options.type)}`);

        return filters.length > 0 ? filters.join(',') : undefined;
    }
}

/**
 * Quote values containing reserved characters the way PostgREST (and the Realtime filter parser) expects
 */
function quoteFilterValue(value: string): string {
    const needsQuoting = /[,()"\\]/.test(value) || value !== value.trim();
    return needsQuoting ? `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : value;
}
