import type {EventRecord, QueryEventsOptions} from "../domain/index.js";

/**
 * Port: Event Publisher
 * Defines contract for real-time event publishing
 */
export interface IEventPublisher {
    subscribe(callback: (event: EventRecord) => void, filter?: QueryEventsOptions): () => void;
}
