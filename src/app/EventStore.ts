import {SupabaseClient} from "@supabase/supabase-js";
import {Redis} from "ioredis";
import {
    CacheConfig,
    CreateEventInput, CreateSnapshotInput,
    EventProjection,
    EventRecord,
    EventStoreError,
    QueryEventsOptions, ReplayOptions, SnapshotRecord
} from "../domain";
import {
    NoOpCacheService,
    RedisCacheService,
    SupabaseEventPublisher,
    SupabaseEventRepository, SupabaseSequenceRepository,
    SupabaseSnapshotRepository
} from "../adapters";
import {ICacheService, IEventPublisher, IEventRepository, ISequenceRepository, ISnapshotRepository} from "../ports";

/**
 * Event Store Service Configuration
 */
export interface EventStoreConfig {
    eventRepository: IEventRepository;
    sequenceRepository: ISequenceRepository;
    snapshotRepository: ISnapshotRepository;
    cacheService: ICacheService;
    eventPublisher?: IEventPublisher;
}

/**
 * Event Store Service - Core Business Logic
 */
export class EventStore {
    constructor(private readonly config: EventStoreConfig) {}

    // ============================================================================
    // EVENT OPERATIONS
    // ============================================================================

    /**
     * Append a single event to the event store
     */
    async appendEvent(event: CreateEventInput): Promise<EventRecord> {
        try {
            const sequenceNumber = await this.config.sequenceRepository.getNextSequence(
                event.aggregate_id,
                event.aggregate_type
            );

            const savedEvent = await this.config.eventRepository.saveEvent(event, sequenceNumber);

            await this.invalidateAggregateCache(event.aggregate_id, event.aggregate_type);

            return savedEvent;
        } catch (err) {
            if (err instanceof EventStoreError) throw err;
            throw new EventStoreError('Failed to append event', err);
        }
    }

    /**
     * Append multiple events atomically
     */
    async appendEvents(events: CreateEventInput[]): Promise<EventRecord[]> {
        if (events.length === 0) return [];

        try {
            const eventsByAggregate = this.groupEventsByAggregate(events);
            const sequenceMap = await this.reserveSequences(eventsByAggregate);

            const eventsWithSequences = events.map(event => {
                const key = this.aggregateKey(event.aggregate_id, event.aggregate_type);
                const groupEvents = eventsByAggregate.get(key)!;
                const indexInGroup = groupEvents.indexOf(event);
                const startSequence = sequenceMap.get(key)!;

                return {
                    event,
                    sequenceNumber: startSequence + indexInGroup,
                };
            });

            const savedEvents = await this.config.eventRepository.saveEvents(eventsWithSequences);

            await Promise.all(
                Array.from(eventsByAggregate.keys()).map(key => {
                    const [aggregateId, aggregateType] = key.split(':');
                    return this.invalidateAggregateCache(aggregateId, aggregateType);
                })
            );

            return savedEvents;
        } catch (err) {
            if (err instanceof EventStoreError) throw err;
            throw new EventStoreError('Failed to append events', err);
        }
    }

    /**
     * Query events from the event store
     */
    async queryEvents(options: QueryEventsOptions = {}): Promise<EventRecord[]> {
        try {
            return await this.config.eventRepository.findEvents(options);
        } catch (err) {
            if (err instanceof EventStoreError) throw err;
            throw new EventStoreError('Failed to query events', err);
        }
    }

    /**
     * Get events for a specific aggregate
     */
    async getAggregateEvents(
        aggregateId: string,
        aggregateType: string,
        fromSequence?: number
    ): Promise<EventRecord[]> {
        try {
            const cacheKey = this.buildCacheKey('agg', aggregateType, aggregateId, fromSequence?.toString() ?? 'all');

            const cached = await this.config.cacheService.get<EventRecord[]>(cacheKey);
            if (cached) return cached;

            const events = await this.config.eventRepository.findEventsByAggregate(
                aggregateId,
                aggregateType,
                fromSequence
            );

            const ttl = this.getCacheTTL('aggregateEvents');
            if (ttl > 0) {
                await this.config.cacheService.set(cacheKey, events, ttl);
            }

            return events;
        } catch (err) {
            if (err instanceof EventStoreError) throw err;
            throw new EventStoreError('Failed to get aggregate events', err);
        }
    }

    /**
     * Get events by type
     */
    async getEventsByType(type: string, limit?: number): Promise<EventRecord[]> {
        try {
            return await this.config.eventRepository.findEventsByType(type, limit);
        } catch (err) {
            if (err instanceof EventStoreError) throw err;
            throw new EventStoreError('Failed to get events by type', err);
        }
    }

    /**
     * Get the latest event for an aggregate
     */
    async getLatestEvent(
        aggregateId: string,
        aggregateType: string
    ): Promise<EventRecord | null> {
        try {
            return await this.config.eventRepository.findLatestEvent(aggregateId, aggregateType);
        } catch (err) {
            if (err instanceof EventStoreError) throw err;
            throw new EventStoreError('Failed to get latest event', err);
        }
    }

    /**
     * Get current sequence number for an aggregate
     */
    async getCurrentSequenceNumber(
        aggregateId: string,
        aggregateType: string
    ): Promise<number> {
        try {
            const cacheKey = this.buildCacheKey('seq', aggregateType, aggregateId);

            const cached = await this.config.cacheService.get<number>(cacheKey);
            if (cached !== null) return cached;

            const sequence = await this.config.sequenceRepository.getCurrentSequence(
                aggregateId,
                aggregateType
            );

            const ttl = this.getCacheTTL('sequences');
            if (ttl > 0) {
                await this.config.cacheService.set(cacheKey, sequence, ttl);
            }

            return sequence;
        } catch (err) {
            if (err instanceof EventStoreError) throw err;
            throw new EventStoreError('Failed to get current sequence number', err);
        }
    }

    /**
     * Subscribe to real-time events
     */
    subscribeToEvents(
        callback: (event: EventRecord) => void,
        options: Omit<QueryEventsOptions, 'limit' | 'order'> = {}
    ): () => void {
        if (!this.config.eventPublisher) {
            throw new EventStoreError('Event publisher not configured');
        }
        return this.config.eventPublisher.subscribe(callback, options);
    }

    // ============================================================================
    // SNAPSHOT OPERATIONS
    // ============================================================================

    /**
     * Create a snapshot of an aggregate's current state
     */
    async createSnapshot(snapshot: CreateSnapshotInput): Promise<SnapshotRecord> {
        try {
            const saved = await this.config.snapshotRepository.saveSnapshot(snapshot);

            const cacheKey = this.buildCacheKey(
                'snapshot',
                snapshot.aggregate_type,
                snapshot.aggregate_id,
                'latest'
            );

            const ttl = this.getCacheTTL('snapshots');
            if (ttl > 0) {
                await this.config.cacheService.set(cacheKey, saved, ttl);
            }

            return saved;
        } catch (err) {
            if (err instanceof EventStoreError) throw err;
            throw new EventStoreError('Failed to create snapshot', err);
        }
    }

    /**
     * Get the latest snapshot for an aggregate
     */
    async getLatestSnapshot(
        aggregateId: string,
        aggregateType: string
    ): Promise<SnapshotRecord | null> {
        try {
            const cacheKey = this.buildCacheKey('snapshot', aggregateType, aggregateId, 'latest');

            const cached = await this.config.cacheService.get<SnapshotRecord>(cacheKey);
            if (cached) return cached;

            const snapshot = await this.config.snapshotRepository.findLatestSnapshot(
                aggregateId,
                aggregateType
            );

            if (snapshot) {
                const ttl = this.getCacheTTL('snapshots');
                if (ttl > 0) {
                    await this.config.cacheService.set(cacheKey, snapshot, ttl);
                }
            }

            return snapshot;
        } catch (err) {
            if (err instanceof EventStoreError) throw err;
            throw new EventStoreError('Failed to get latest snapshot', err);
        }
    }

    /**
     * Get a snapshot at a specific sequence number
     */
    async getSnapshotAtSequence(
        aggregateId: string,
        aggregateType: string,
        sequenceNumber: number
    ): Promise<SnapshotRecord | null> {
        try {
            return await this.config.snapshotRepository.findSnapshotAtSequence(
                aggregateId,
                aggregateType,
                sequenceNumber
            );
        } catch (err) {
            if (err instanceof EventStoreError) throw err;
            throw new EventStoreError('Failed to get snapshot at sequence', err);
        }
    }

    /**
     * Delete old snapshots, keeping only the N most recent
     */
    async pruneSnapshots(
        aggregateId: string,
        aggregateType: string,
        keepCount: number = 3
    ): Promise<number> {
        try {
            return await this.config.snapshotRepository.deleteOldSnapshots(
                aggregateId,
                aggregateType,
                keepCount
            );
        } catch (err) {
            if (err instanceof EventStoreError) throw err;
            throw new EventStoreError('Failed to prune snapshots', err);
        }
    }

    // ============================================================================
    // EVENT REPLAY & PROJECTIONS
    // ============================================================================

    /**
     * Replay events and build aggregate state using a projection
     */
    async replayEvents<T>(
        aggregateId: string,
        aggregateType: string,
        projection: EventProjection<T>,
        options: ReplayOptions = {}
    ): Promise<T> {
        try {
            let state = projection.initialState;
            let fromSequence = options.from_sequence ?? 1;

            if (!options.from_sequence) {
                const snapshot = await this.getLatestSnapshot(aggregateId, aggregateType);
                if (snapshot) {
                    state = snapshot.state;
                    fromSequence = snapshot.sequence_number + 1;
                }
            }

            const events = await this.queryEvents({
                aggregate_id: aggregateId,
                aggregate_type: aggregateType,
                from_sequence: fromSequence,
                to_sequence: options.to_sequence,
                order: 'asc',
            });

            for (const event of events) {
                state = projection.applyEvent(state, event);
            }

            return state;
        } catch (err) {
            if (err instanceof EventStoreError) throw err;
            throw new EventStoreError('Failed to replay events', err);
        }
    }

    /**
     * Replay events in batches with callback for each batch
     */
    async replayEventStream(
        options: Omit<QueryEventsOptions, 'limit'>,
        batchCallback: (events: EventRecord[], batchNumber: number) => Promise<void>,
        batchSize: number = 100
    ): Promise<void> {
        try {
            let batchNumber = 0;
            let hasMore = true;
            let lastSequence = options.from_sequence ?? 0;

            while (hasMore) {
                const events = await this.queryEvents({
                    ...options,
                    from_sequence: lastSequence + 1,
                    limit: batchSize,
                    order: 'asc',
                });

                if (events.length === 0) break;

                await batchCallback(events, batchNumber);

                lastSequence = events[events.length - 1].sequence_number;
                batchNumber++;

                if (events.length < batchSize) {
                    hasMore = false;
                }
            }
        } catch (err) {
            if (err instanceof EventStoreError) throw err;
            throw new EventStoreError('Failed to replay event stream', err);
        }
    }

    /**
     * Rebuild aggregate state with automatic snapshotting
     */
    async rebuildWithSnapshots<T>(
        aggregateId: string,
        aggregateType: string,
        projection: EventProjection<T>,
        snapshotInterval: number = 50
    ): Promise<T> {
        try {
            let state = projection.initialState;
            let lastSnapshotSequence = 0;

            const snapshot = await this.getLatestSnapshot(aggregateId, aggregateType);
            if (snapshot) {
                state = snapshot.state;
                lastSnapshotSequence = snapshot.sequence_number;
            }

            const events = await this.queryEvents({
                aggregate_id: aggregateId,
                aggregate_type: aggregateType,
                from_sequence: lastSnapshotSequence + 1,
                order: 'asc',
            });

            for (let i = 0; i < events.length; i++) {
                const event = events[i];
                state = projection.applyEvent(state, event);

                if ((i + 1) % snapshotInterval === 0) {
                    await this.createSnapshot({
                        aggregate_id: aggregateId,
                        aggregate_type: aggregateType,
                        sequence_number: event.sequence_number,
                        state: state,
                    });
                }
            }

            if (events.length > 0) {
                const lastEvent = events[events.length - 1];
                if (lastEvent.sequence_number > lastSnapshotSequence) {
                    await this.createSnapshot({
                        aggregate_id: aggregateId,
                        aggregate_type: aggregateType,
                        sequence_number: lastEvent.sequence_number,
                        state: state,
                    });
                }
            }

            return state;
        } catch (err) {
            if (err instanceof EventStoreError) throw err;
            throw new EventStoreError('Failed to rebuild with snapshots', err);
        }
    }

    /**
     * Get aggregate state at a specific point in time
     */
    async getStateAtSequence<T>(
        aggregateId: string,
        aggregateType: string,
        projection: EventProjection<T>,
        sequenceNumber: number
    ): Promise<T> {
        return this.replayEvents(aggregateId, aggregateType, projection, {
            to_sequence: sequenceNumber,
        });
    }

    /**
     * Get event statistics for an aggregate
     */
    async getAggregateStats(
        aggregateId: string,
        aggregateType: string
    ): Promise<{
        totalEvents: number;
        firstEvent: EventRecord | null;
        lastEvent: EventRecord | null;
        eventTypes: Map<string, number>;
    }> {
        try {
            const cacheKey = this.buildCacheKey('stats', aggregateType, aggregateId);

            const cached = await this.config.cacheService.get<{
                totalEvents: number;
                firstEvent: EventRecord | null;
                lastEvent: EventRecord | null;
                eventTypes: Array<[string, number]>;
            }>(cacheKey);

            if (cached) {
                return {
                    totalEvents: cached.totalEvents,
                    firstEvent: cached.firstEvent,
                    lastEvent: cached.lastEvent,
                    eventTypes: new Map(cached.eventTypes),
                };
            }

            const events = await this.getAggregateEvents(aggregateId, aggregateType);

            const eventTypes = new Map<string, number>();
            events.forEach(event => {
                eventTypes.set(event.type, (eventTypes.get(event.type) ?? 0) + 1);
            });

            const stats = {
                totalEvents: events.length,
                firstEvent: events[0] ?? null,
                lastEvent: events[events.length - 1] ?? null,
                eventTypes: Array.from(eventTypes.entries()),
            };

            const ttl = this.getCacheTTL('aggregateEvents');
            if (ttl > 0) {
                await this.config.cacheService.set(cacheKey, stats, ttl);
            }

            return {
                totalEvents: stats.totalEvents,
                firstEvent: stats.firstEvent,
                lastEvent: stats.lastEvent,
                eventTypes: new Map(stats.eventTypes),
            };
        } catch (err) {
            if (err instanceof EventStoreError) throw err;
            throw new EventStoreError('Failed to get aggregate stats', err);
        }
    }

    /**
     * Validate event stream consistency for an aggregate
     */
    async validateEventStream(
        aggregateId: string,
        aggregateType: string
    ): Promise<{
        valid: boolean;
        issues: string[];
    }> {
        try {
            const events = await this.getAggregateEvents(aggregateId, aggregateType);
            const issues: string[] = [];

            if (events.length === 0) {
                return { valid: true, issues: [] };
            }

            for (let i = 0; i < events.length; i++) {
                const expectedSequence = i + 1;
                if (events[i].sequence_number !== expectedSequence) {
                    issues.push(
                        `Sequence gap: expected ${expectedSequence}, got ${events[i].sequence_number}`
                    );
                }
            }

            const wrongAggregate = events.find(
                e => e.aggregate_id !== aggregateId || e.aggregate_type !== aggregateType
            );

            if (wrongAggregate) {
                issues.push('Events with mismatched aggregate ID or type found');
            }

            return {
                valid: issues.length === 0,
                issues,
            };
        } catch (err) {
            if (err instanceof EventStoreError) throw err;
            throw new EventStoreError('Failed to validate event stream', err);
        }
    }

    // ============================================================================
    // CACHE MANAGEMENT
    // ============================================================================

    /**
     * Clear all cache
     */
    async clearCache(): Promise<void> {
        try {
            const pattern = this.buildCacheKey('*');
            await this.config.cacheService.deletePattern(pattern);
        } catch (err) {
            console.error('Failed to clear cache:', err);
        }
    }

    /**
     * Clear cache for specific aggregate
     */
    async clearAggregateCache(aggregateId: string, aggregateType: string): Promise<void> {
        await this.invalidateAggregateCache(aggregateId, aggregateType);
    }

    /**
     * Warm up cache for an aggregate
     */
    async warmupCache(aggregateId: string, aggregateType: string): Promise<void> {
        try {
            await Promise.all([
                this.getAggregateEvents(aggregateId, aggregateType),
                this.getLatestSnapshot(aggregateId, aggregateType),
                this.getCurrentSequenceNumber(aggregateId, aggregateType),
                this.getAggregateStats(aggregateId, aggregateType),
            ]);
        } catch (err) {
            console.error('Failed to warm up cache:', err);
        }
    }

    /**
     * Get cache statistics
     */
    async getCacheStats(): Promise<{
        enabled: boolean;
        type: string;
        info?: {
            keys: number;
            memory: string;
        };
    }> {
        const stats: {
            enabled: boolean;
            type: string;
            info?: {
                keys: number;
                memory: string;
            };
        } = {
            enabled: !(this.config.cacheService instanceof NoOpCacheService),
            type: this.config.cacheService.constructor.name,
        };

        if (this.config.cacheService instanceof RedisCacheService) {
            try {
                const redis = this.config.cacheService.getRedisClient();
                const pattern = this.buildCacheKey('*');
                const keys = await redis.keys(pattern);
                const info = await redis.info('memory');
                const memoryMatch = info.match(/used_memory_human:([^\r\n]+)/);

                stats.info = {
                    keys: keys.length,
                    memory: memoryMatch ? memoryMatch[1] : 'unknown',
                };
            } catch (err) {
                console.error('Failed to get cache stats:', err);
            }
        }

        return stats;
    }

    // ============================================================================
    // PRIVATE HELPERS
    // ============================================================================

    /**
     * Build cache key with proper prefix
     */
    private buildCacheKey(...parts: string[]): string {
        if (this.config.cacheService instanceof RedisCacheService) {
            return this.config.cacheService.buildCacheKey(...parts);
        }
        return parts.join(':');
    }

    /**
     * Get cache TTL for a specific type
     */
    private getCacheTTL(type: 'events' | 'snapshots' | 'sequences' | 'aggregateEvents'): number {
        if (this.config.cacheService instanceof RedisCacheService) {
            return this.config.cacheService.getTTL(type);
        }
        return 0;
    }

    /**
     * Group events by aggregate
     */
    private groupEventsByAggregate(events: CreateEventInput[]): Map<string, CreateEventInput[]> {
        const map = new Map<string, CreateEventInput[]>();

        for (const event of events) {
            const key = this.aggregateKey(event.aggregate_id, event.aggregate_type);
            const group = map.get(key) ?? [];
            group.push(event);
            map.set(key, group);
        }

        return map;
    }

    /**
     * Reserve sequence numbers for multiple aggregates
     */
    private async reserveSequences(
        eventsByAggregate: Map<string, CreateEventInput[]>
    ): Promise<Map<string, number>> {
        const sequencePromises = Array.from(eventsByAggregate.entries()).map(
            async ([key, events]) => {
                const [aggregateId, aggregateType] = key.split(':');
                const startSequence = await this.config.sequenceRepository.getNextSequence(
                    aggregateId,
                    aggregateType,
                    events.length
                );
                return { key, startSequence };
            }
        );

        const sequences = await Promise.all(sequencePromises);
        return new Map(sequences.map(s => [s.key, s.startSequence]));
    }

    /**
     * Invalidate all cache entries for an aggregate
     */
    private async invalidateAggregateCache(aggregateId: string, aggregateType: string): Promise<void> {
        const patterns = [
            this.buildCacheKey('agg', aggregateType, aggregateId) + '*',
            this.buildCacheKey('snapshot', aggregateType, aggregateId) + '*',
            this.buildCacheKey('seq', aggregateType, aggregateId),
            this.buildCacheKey('stats', aggregateType, aggregateId),
        ];

        await Promise.all(patterns.map(p => this.config.cacheService.deletePattern(p)));
    }

    /**
     * Generate aggregate key
     */
    private aggregateKey(aggregateId: string, aggregateType: string): string {
        return `${aggregateId}:${aggregateType}`;
    }
}

// ============================================================================
// FACTORY - Builder for Event Store with Supabase
// ============================================================================

/**
 * Event Store Builder Configuration
 */
export interface EventStoreBuilderConfig {
    supabase: SupabaseClient;
    redis?: Redis;
    cache?: CacheConfig;
    enablePublisher?: boolean;
}

/**
 * Factory function to create Event Store with Supabase adapters
 */
export function createEventStore(config: EventStoreBuilderConfig): EventStore {
    const eventRepository = new SupabaseEventRepository(config.supabase);
    const sequenceRepository = new SupabaseSequenceRepository(config.supabase);
    const snapshotRepository = new SupabaseSnapshotRepository(config.supabase);

    const cacheService = config.redis
        ? new RedisCacheService(config.redis, config.cache)
        : new NoOpCacheService();

    const eventPublisher = config.enablePublisher
        ? new SupabaseEventPublisher(config.supabase)
        : undefined;

    return new EventStore({
        eventRepository,
        sequenceRepository,
        snapshotRepository,
        cacheService,
        eventPublisher,
    });
}

// Default export
export default EventStore;