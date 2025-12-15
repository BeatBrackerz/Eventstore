import {CreateEventInput, EventRecord, QueryEventsOptions} from "../domain";

/**
 * Port: Event Repository
 * Defines contract for event persistence
 */
export interface IEventRepository {
    saveEvent(event: CreateEventInput, sequenceNumber: number): Promise<EventRecord>;
    saveEvents(events: Array<{ event: CreateEventInput; sequenceNumber: number }>): Promise<EventRecord[]>;
    findEvents(options: QueryEventsOptions): Promise<EventRecord[]>;
    findEventsByAggregate(aggregateId: string, aggregateType: string, fromSequence?: number): Promise<EventRecord[]>;
    findEventsByType(type: string, limit?: number): Promise<EventRecord[]>;
    findLatestEvent(aggregateId: string, aggregateType: string): Promise<EventRecord | null>;
}