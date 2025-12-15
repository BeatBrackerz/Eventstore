import { SupabaseClient } from '@supabase/supabase-js';
import {CreateEventInput, EventRecord, EventStoreError, QueryEventsOptions} from "../domain";
import {IEventRepository} from "../ports";

/**
 * Adapter: Supabase Event Repository
 */
export class SupabaseEventRepository implements IEventRepository {
    private readonly tableName = 'events';

    constructor(private readonly client: SupabaseClient) {}

    async saveEvent(event: CreateEventInput, sequenceNumber: number): Promise<EventRecord> {
        const { data, error } = await this.client
            .from(this.tableName)
            .insert({
                type: event.type,
                aggregate_id: event.aggregate_id,
                aggregate_type: event.aggregate_type,
                sequence_number: sequenceNumber,
                version: event.version ?? 1,
                payload: event.payload ?? {},
                metadata: event.metadata ?? {},
                created_by: event.created_by,
            })
            .select()
            .single();

        if (error) throw new EventStoreError(`Failed to save event: ${error.message}`, error);
        return data as EventRecord;
    }

    async saveEvents(events: Array<{ event: CreateEventInput; sequenceNumber: number }>): Promise<EventRecord[]> {
        const eventsToInsert = events.map(({ event, sequenceNumber }) => ({
            type: event.type,
            aggregate_id: event.aggregate_id,
            aggregate_type: event.aggregate_type,
            sequence_number: sequenceNumber,
            version: event.version ?? 1,
            payload: event.payload ?? {},
            metadata: event.metadata ?? {},
            created_by: event.created_by,
        }));

        const { data, error } = await this.client
            .from(this.tableName)
            .insert(eventsToInsert)
            .select();

        if (error) throw new EventStoreError(`Failed to save events: ${error.message}`, error);
        return data as EventRecord[];
    }

    async findEvents(options: QueryEventsOptions): Promise<EventRecord[]> {
        let query = this.client.from(this.tableName).select('*');

        if (options.aggregate_id) query = query.eq('aggregate_id', options.aggregate_id);
        if (options.aggregate_type) query = query.eq('aggregate_type', options.aggregate_type);
        if (options.type) query = query.eq('type', options.type);
        if (options.from_sequence !== undefined) query = query.gte('sequence_number', options.from_sequence);
        if (options.to_sequence !== undefined) query = query.lte('sequence_number', options.to_sequence);

        query = query.order('sequence_number', { ascending: options.order !== 'desc' });
        if (options.limit) query = query.limit(options.limit);

        const { data, error } = await query;
        if (error) throw new EventStoreError(`Failed to find events: ${error.message}`, error);
        return (data as EventRecord[]) ?? [];
    }

    async findEventsByAggregate(aggregateId: string, aggregateType: string, fromSequence?: number): Promise<EventRecord[]> {
        return this.findEvents({
            aggregate_id: aggregateId,
            aggregate_type: aggregateType,
            from_sequence: fromSequence,
            order: 'asc',
        });
    }

    async findEventsByType(type: string, limit?: number): Promise<EventRecord[]> {
        return this.findEvents({ type, limit, order: 'desc' });
    }

    async findLatestEvent(aggregateId: string, aggregateType: string): Promise<EventRecord | null> {
        const events = await this.findEvents({
            aggregate_id: aggregateId,
            aggregate_type: aggregateType,
            order: 'desc',
            limit: 1,
        });
        return events[0] ?? null;
    }
}