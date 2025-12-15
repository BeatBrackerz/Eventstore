/**
 * Port: Sequence Repository
 * Defines contract for sequence number management
 */
export interface ISequenceRepository {
    getCurrentSequence(aggregateId: string, aggregateType: string): Promise<number>;
    getNextSequence(aggregateId: string, aggregateType: string, count?: number): Promise<number>;
}