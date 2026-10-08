import type {CreateEventInput, EventRecord, Position, QueryEventsOptions, SnapshotRecord} from "../domain/index.js";

/**
 * Query for loading an aggregate's event stream in one call
 */
export interface StreamQuery {
    aggregateId: string;
    aggregateType: string;
    fromSequence?: number; // First sequence number to return (default: 1)
    toSequence?: number; // Last sequence number to return (inclusive)
    withSnapshot?: boolean; // Start after the latest snapshot at or before toSequence (ignores fromSequence)
}

/**
 * Result of {@link IEventRepository.loadStream}
 */
export interface LoadedStream {
    snapshot: SnapshotRecord | null;
    events: EventRecord[];
}

/**
 * Aggregate statistics as computed by the database
 */
export interface AggregateStatsData {
    totalEvents: number;
    firstEvent: EventRecord | null;
    lastEvent: EventRecord | null;
    eventTypes: Array<[string, number]>;
}

/**
 * Query for reading events of all aggregates in commit order
 */
export interface ReadAllQuery {
    after: Position; // Exclusive
    limit: number;
    eventTypes?: readonly string[]; // Only events of these types
    aggregateTypes?: readonly string[]; // Only events of these aggregate types
}

/**
 * Result of {@link IEventRepository.readAll}
 */
export interface ReadAllResult {
    events: EventRecord[];
    next: Position; // Where to continue; ahead of the last event when filtered events were skipped
    done: boolean; // No further events available right now
}

/**
 * Port: Event Repository
 * Defines contract for event persistence
 *
 * The optional methods are fast paths. They resolve to `undefined` when the backend
 * cannot serve them, in which case the EventStore falls back to the required methods.
 */
export interface IEventRepository {
    saveEvent(event: CreateEventInput, sequenceNumber: number): Promise<EventRecord>;
    saveEvents(events: Array<{ event: CreateEventInput; sequenceNumber: number }>): Promise<EventRecord[]>;
    findEvents(options: QueryEventsOptions): Promise<EventRecord[]>;
    findEventsByAggregate(aggregateId: string, aggregateType: string, fromSequence?: number): Promise<EventRecord[]>;
    findEventsByType(type: string, limit?: number): Promise<EventRecord[]>;
    findLatestEvent(aggregateId: string, aggregateType: string): Promise<EventRecord | null>;

    /** Allocate sequence numbers and store the events atomically, in input order. */
    appendEvents?(events: CreateEventInput[]): Promise<EventRecord[] | undefined>;
    /** Load (optionally) the latest snapshot and the events after it in one call. */
    loadStream?(query: StreamQuery): Promise<LoadedStream | undefined>;
    /** Compute aggregate statistics without transferring the whole stream. */
    getAggregateStats?(aggregateId: string, aggregateType: string): Promise<AggregateStatsData | undefined>;
    /** Page through matching events in global order (created_at, sequence_number, id). */
    findEventsPage?(options: Omit<QueryEventsOptions, 'limit' | 'order'>, offset: number, limit: number): Promise<EventRecord[]>;
    /**
     * Events of all aggregates after a position, in commit order. Must never return an event
     * behind a position it has already returned (events of transactions still running are held back).
     * Required for projections.
     */
    readAll?(query: ReadAllQuery): Promise<ReadAllResult | undefined>;
}
