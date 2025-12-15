/**
 * Event metadata interface
 */
export interface EventMetadata {
    [key: string]: any;
}

/**
 * Event payload interface
 */
export interface EventPayload {
    [key: string]: any;
}

/**
 * Event record as stored in database
 */
export interface EventRecord {
    id: string;
    type: string;
    aggregate_id: string;
    aggregate_type: string;
    sequence_number: number;
    version: number;
    payload: EventPayload;
    metadata: EventMetadata;
    created_at: string;
    created_by: string;
}

/**
 * Event to be created
 */
export interface CreateEventInput {
    type: string;
    aggregate_id: string;
    aggregate_type: string;
    payload?: EventPayload;
    metadata?: EventMetadata;
    created_by: string;
    version?: number;
}

/**
 * Query options for retrieving events
 */
export interface QueryEventsOptions {
    aggregate_id?: string;
    aggregate_type?: string;
    type?: string;
    from_sequence?: number;
    to_sequence?: number;
    limit?: number;
    order?: 'asc' | 'desc';
}

/**
 * Event replay options
 */
export interface ReplayOptions {
    from_sequence?: number;
    to_sequence?: number;
    batch_size?: number;
}

/**
 * Projection interface for event replay
 */
export interface EventProjection<T = any> {
    initialState: T;
    applyEvent: (state: T, event: EventRecord) => T;
}

/**
 * Event store error
 */
export class EventStoreError extends Error {
    constructor(message: string, public readonly cause?: unknown) {
        super(message);
        this.name = 'EventStoreError';
    }
}