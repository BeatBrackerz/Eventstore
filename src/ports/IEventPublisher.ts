import {EventRecord, QueryEventsOptions} from "../domain";

/**
 * Port: Event Publisher
 * Defines contract for real-time event publishing
 */
export interface IEventPublisher {
    subscribe(callback: (event: EventRecord) => void, filter?: QueryEventsOptions): () => void;
}