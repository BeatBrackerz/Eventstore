import {CreateEventInput, EventRecord, EventStoreError, QueryEventsOptions} from "../domain/index.js";
import type {AggregateStatsData, IEventRepository, LoadedStream, ReadAllQuery, ReadAllResult, StreamQuery} from "../ports/index.js";
import {type AnySupabaseClient, DEFAULT_PAGE_SIZE, RpcSupport, type SupabaseAdapterOptions} from "./supabaseSupport.js";

type EventFilters = Omit<QueryEventsOptions, 'limit' | 'order'>;
type SortKey = ['sequence_number' | 'created_at' | 'id', boolean];

// The load function returns one JSON value, so it is not capped by max-rows; page anyway to bound memory
const RPC_PAGE_SIZE = 10_000;

/**
 * Adapter: Supabase Event Repository
 */
export class SupabaseEventRepository implements IEventRepository {
    private readonly tableName = 'events';
    private readonly rpc: RpcSupport;
    private readonly pageSize: number;

    constructor(private readonly client: AnySupabaseClient, options: SupabaseAdapterOptions = {}) {
        this.rpc = new RpcSupport(client, options.rpc);
        this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    }

    async saveEvent(event: CreateEventInput, sequenceNumber: number): Promise<EventRecord> {
        const { data, error } = await this.client
            .from(this.tableName)
            .insert({ ...toRow(event), sequence_number: sequenceNumber })
            .select()
            .single();

        if (error) throw new EventStoreError(`Failed to save event: ${error.message}`, error);
        return data as EventRecord;
    }

    async saveEvents(events: Array<{ event: CreateEventInput; sequenceNumber: number }>): Promise<EventRecord[]> {
        const eventsToInsert = events.map(({ event, sequenceNumber }) => ({
            ...toRow(event),
            sequence_number: sequenceNumber,
        }));

        const { data, error } = await this.client
            .from(this.tableName)
            .insert(eventsToInsert)
            .select();

        if (error) throw new EventStoreError(`Failed to save events: ${error.message}`, error);
        return data as EventRecord[];
    }

    /**
     * Find events. Without `limit` all matching events are returned; results larger than
     * PostgREST's max-rows are fetched page by page instead of being silently truncated.
     */
    async findEvents(options: QueryEventsOptions): Promise<EventRecord[]> {
        const ascending = options.order !== 'desc';
        return this.fetchPages(options, [['sequence_number', ascending], ['id', ascending]], 0, options.limit || undefined);
    }

    async findEventsByAggregate(aggregateId: string, aggregateType: string, fromSequence?: number): Promise<EventRecord[]> {
        return this.findEvents({
            aggregate_id: aggregateId,
            aggregate_type: aggregateType,
            from_sequence: fromSequence,
            order: 'asc',
        });
    }

    /**
     * Most recent events of a type first
     */
    async findEventsByType(type: string, limit?: number): Promise<EventRecord[]> {
        return this.fetchPages({ type }, [['created_at', false], ['sequence_number', false], ['id', false]], 0, limit || undefined);
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

    async findEventsPage(options: EventFilters, offset: number, limit: number): Promise<EventRecord[]> {
        return this.fetchPages(options, [['created_at', true], ['sequence_number', true], ['id', true]], offset, limit);
    }

    /**
     * Atomic append in one round trip (requires `es_append_events`)
     */
    async appendEvents(events: CreateEventInput[]): Promise<EventRecord[] | undefined> {
        return this.rpc.call<EventRecord[]>('es_append_events', { p_events: events.map(toRow) });
    }

    /**
     * Snapshot and events in one round trip (requires `es_load_stream`)
     */
    async loadStream(query: StreamQuery): Promise<LoadedStream | undefined> {
        const args = {
            p_aggregate_id: query.aggregateId,
            p_aggregate_type: query.aggregateType,
            p_to_sequence: query.toSequence ?? null,
            p_limit: RPC_PAGE_SIZE,
        };

        const first = await this.rpc.call<LoadedStream>('es_load_stream', {
            ...args,
            p_from_sequence: query.fromSequence ?? 1,
            p_use_snapshot: query.withSnapshot ?? false,
        });
        if (!first) return undefined;

        const events = first.events;
        let page = events;
        while (page.length === RPC_PAGE_SIZE) {
            const next = await this.rpc.call<LoadedStream>('es_load_stream', {
                ...args,
                p_from_sequence: page[page.length - 1].sequence_number + 1,
                p_use_snapshot: false,
            });
            if (!next) throw new EventStoreError('Failed to load stream: es_load_stream became unavailable while paging');
            page = next.events;
            for (const event of page) events.push(event);
        }

        return { snapshot: first.snapshot ?? null, events };
    }

    /**
     * Statistics computed in the database (requires `es_aggregate_stats`)
     */
    async getAggregateStats(aggregateId: string, aggregateType: string): Promise<AggregateStatsData | undefined> {
        return this.rpc.call<AggregateStatsData>('es_aggregate_stats', {
            p_aggregate_id: aggregateId,
            p_aggregate_type: aggregateType,
        });
    }

    /**
     * Events of all aggregates in commit order (requires `es_read_all`)
     */
    async readAll(query: ReadAllQuery): Promise<ReadAllResult | undefined> {
        const result = await this.rpc.call<{ events: EventRecord[]; next: { transaction_id: string; global_position: number }; done: boolean }>(
            'es_read_all',
            {
                p_after_transaction_id: query.after.transactionId,
                p_after_position: query.after.globalPosition,
                p_limit: query.limit,
                p_event_types: query.eventTypes ?? null,
                p_aggregate_types: query.aggregateTypes ?? null,
            }
        );
        if (!result) return undefined;

        return {
            events: result.events,
            next: { transactionId: result.next.transaction_id, globalPosition: Number(result.next.global_position) },
            done: result.done,
        };
    }

    private async fetchPages(filters: EventFilters, sort: SortKey[], offset: number, limit?: number): Promise<EventRecord[]> {
        const rows: EventRecord[] = [];

        for (;;) {
            const pageSize = limit === undefined ? this.pageSize : Math.min(this.pageSize, limit - rows.length);

            let query = this.client.from(this.tableName).select('*');
            if (filters.aggregate_id) query = query.eq('aggregate_id', filters.aggregate_id);
            if (filters.aggregate_type) query = query.eq('aggregate_type', filters.aggregate_type);
            if (filters.type) query = query.eq('type', filters.type);
            if (filters.from_sequence !== undefined) query = query.gte('sequence_number', filters.from_sequence);
            if (filters.to_sequence !== undefined) query = query.lte('sequence_number', filters.to_sequence);
            for (const [column, ascending] of sort) query = query.order(column, { ascending });

            const { data, error } = await query.range(offset, offset + pageSize - 1);
            if (error) throw new EventStoreError(`Failed to find events: ${error.message}`, error);

            const page = (data ?? []) as EventRecord[];
            for (const row of page) rows.push(row);
            offset += page.length;

            if (page.length < pageSize || rows.length === limit) return rows;
        }
    }
}

function toRow(event: CreateEventInput) {
    return {
        type: event.type,
        aggregate_id: event.aggregate_id,
        aggregate_type: event.aggregate_type,
        version: event.version ?? 1,
        payload: event.payload ?? {},
        metadata: event.metadata ?? {},
        created_by: event.created_by,
    };
}
