import type {SupabaseClient} from "@supabase/supabase-js";
import {
    CacheConfig,
    CreateEventInput, CreateSnapshotInput,
    EventProjection,
    EventRecord,
    EventStoreError,
    type Position,
    QueryEventsOptions, RedisClientLike, ReplayOptions, SnapshotRecord,
    START_POSITION
} from "../domain/index.js";
import {
    MemoryCacheService,
    NoOpCacheService,
    RedisCacheService,
    SupabaseEventPublisher,
    SupabaseEventRepository, SupabaseReadModelStore, SupabaseSequenceRepository,
    SupabaseSnapshotRepository
} from "../adapters/index.js";
import type {
    AggregateStatsData,
    ICacheService,
    IEventPublisher,
    IEventRepository,
    IReadModelStore,
    ISequenceRepository,
    ISnapshotRepository,
    LoadedStream,
    ReadAllResult
} from "../ports/index.js";
import {AggregateCache, type AggregateRef, type Freshness, lastSequence, sliceStream, type StreamEntry} from "./AggregateCache.js";
import {cloneJson, SingleFlight} from "./SingleFlight.js";
import {type ProjectionDefinition, ProjectionEngine, type ProjectionOptions, ReadModels} from "./ProjectionEngine.js";

/**
 * Event Store Service Configuration
 */
export interface EventStoreConfig {
    eventRepository: IEventRepository;
    sequenceRepository: ISequenceRepository;
    snapshotRepository: ISnapshotRepository;
    cacheService: ICacheService;
    eventPublisher?: IEventPublisher;
    cache?: CacheConfig; // TTLs, key prefix and consistency of the cache
    readModelStore?: IReadModelStore; // Default store of projections and read model queries
    projections?: readonly ProjectionDefinition[];
    projectionOptions?: ProjectionOptions;
}

/**
 * Event Store Service - Core Business Logic
 */
export class EventStore {
    /** Projections: catch up, rebuild, run in the background, status */
    readonly projections: ProjectionEngine;
    /** Queries of read models (the write side's read tables and search indices) */
    readonly readModels: ReadModels;

    private readonly cache: AggregateCache;
    private readonly flights = new SingleFlight();

    constructor(private readonly config: EventStoreConfig) {
        this.cache = new AggregateCache(config.cacheService, config.cache);
        this.projections = new ProjectionEngine(
            config.eventRepository,
            config.readModelStore,
            config.projections,
            config.projectionOptions,
            config.eventPublisher
        );
        this.readModels = new ReadModels(this.projections);
    }

    // ============================================================================
    // EVENT OPERATIONS
    // ============================================================================

    /**
     * Append a single event to the event store
     */
    async appendEvent(event: CreateEventInput): Promise<EventRecord> {
        try {
            const appended = await this.config.eventRepository.appendEvents?.([event]);
            let savedEvent: EventRecord;

            if (appended) {
                savedEvent = appended[0];
            } else {
                const sequenceNumber = await this.config.sequenceRepository.getNextSequence(
                    event.aggregate_id,
                    event.aggregate_type
                );
                savedEvent = await this.config.eventRepository.saveEvent(event, sequenceNumber);
            }

            await this.cache.afterAppend([savedEvent]);
            await this.projections.afterAppend([savedEvent]);

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
            let savedEvents = await this.config.eventRepository.appendEvents?.(events);

            if (!savedEvents) {
                const eventsWithSequences = await this.reserveSequences(events);
                savedEvents = await this.config.eventRepository.saveEvents(eventsWithSequences);
            }

            await this.cache.afterAppend(savedEvents);
            await this.projections.afterAppend(savedEvents);

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
            return await this.readEvents({ aggregateId, aggregateType }, fromSequence ?? 1, undefined, 'read');
        } catch (err) {
            if (err instanceof EventStoreError) throw err;
            throw new EventStoreError('Failed to get aggregate events', err);
        }
    }

    /**
     * Get events by type, most recent first
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
            const ref = { aggregateId, aggregateType };

            if (this.cache.cachesDerivedValues) {
                const cached = await this.cache.getSequence(ref);
                if (cached !== null) return cached;
            }

            const sequence = await this.config.sequenceRepository.getCurrentSequence(
                aggregateId,
                aggregateType
            );

            if (this.cache.cachesDerivedValues) {
                await this.cache.putSequence(ref, sequence);
            }

            return sequence;
        } catch (err) {
            if (err instanceof EventStoreError) throw err;
            throw new EventStoreError('Failed to get current sequence number', err);
        }
    }

    /**
     * Read events of all aggregates in commit order, e.g. to feed other systems. Continue with
     * `result.next` until `result.done` (requires sql/eventstore.sql).
     */
    async readAll(
        after: Position = START_POSITION,
        options: { limit?: number; eventTypes?: readonly string[]; aggregateTypes?: readonly string[] } = {}
    ): Promise<ReadAllResult> {
        try {
            const result = await this.config.eventRepository.readAll?.({
                after,
                limit: options.limit ?? 1000,
                eventTypes: options.eventTypes,
                aggregateTypes: options.aggregateTypes,
            });
            if (!result) throw new EventStoreError('readAll needs the database function es_read_all: run sql/eventstore.sql');
            return result;
        } catch (err) {
            if (err instanceof EventStoreError) throw err;
            throw new EventStoreError('Failed to read events', err);
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

            await this.cache.offerHead(
                { aggregateId: snapshot.aggregate_id, aggregateType: snapshot.aggregate_type },
                saved
            );

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
            const ref = { aggregateId, aggregateType };

            if (!this.cache.enabled) {
                return await this.config.snapshotRepository.findLatestSnapshot(aggregateId, aggregateType);
            }

            return await this.flights.run(`head|${this.cache.headKey(ref)}`, () => this.syncHead(ref));
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
            const deleted = await this.config.snapshotRepository.deleteOldSnapshots(
                aggregateId,
                aggregateType,
                keepCount
            );

            if (deleted > 0) {
                await this.cache.dropHead({ aggregateId, aggregateType });
            }

            return deleted;
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
            const ref = { aggregateId, aggregateType };
            let state = projection.initialState;
            let events: EventRecord[];

            if (options.from_sequence) {
                events = await this.readEvents(ref, options.from_sequence, options.to_sequence, 'replay');
            } else {
                const source = await this.loadReplaySource(ref, options.to_sequence);
                if (source.snapshot) state = source.snapshot.state;
                events = source.events;
            }

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
            const repository = this.config.eventRepository;
            const singleAggregate = options.aggregate_id !== undefined && options.aggregate_type !== undefined;
            let batchNumber = 0;

            if (!singleAggregate && repository.findEventsPage) {
                // Sequence numbers are per aggregate, so streams across aggregates are paged in global order
                for (let offset = 0; ;) {
                    const events = await repository.findEventsPage(options, offset, batchSize);
                    if (events.length === 0) break;

                    await batchCallback(events, batchNumber++);

                    offset += events.length;
                    if (events.length < batchSize) break;
                }
                return;
            }

            let nextSequence = options.from_sequence ?? 1;

            for (;;) {
                const events = await this.queryEvents({
                    ...options,
                    from_sequence: nextSequence,
                    limit: batchSize,
                    order: 'asc',
                });

                if (events.length === 0) break;

                await batchCallback(events, batchNumber++);

                nextSequence = events[events.length - 1].sequence_number + 1;
                if (events.length < batchSize) break;
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
            const ref = { aggregateId, aggregateType };
            const { snapshot, events } = await this.loadReplaySource(ref);
            let state = snapshot ? snapshot.state : projection.initialState;
            const snapshots: CreateSnapshotInput[] = [];

            for (let i = 0; i < events.length; i++) {
                const event = events[i];
                state = projection.applyEvent(state, event);

                const isLast = i === events.length - 1;
                if (isLast || (snapshotInterval > 0 && (i + 1) % snapshotInterval === 0)) {
                    snapshots.push({
                        aggregate_id: aggregateId,
                        aggregate_type: aggregateType,
                        sequence_number: event.sequence_number,
                        // Projections may mutate state in place, so intermediate states are copied
                        state: isLast ? state : cloneJson(state),
                    });
                }
            }

            if (snapshots.length > 0) {
                await this.saveSnapshots(ref, snapshots);
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
            const ref = { aggregateId, aggregateType };
            const stats = await this.flights.run(`stats|${this.cache.statsKey(ref)}`, () => this.loadStats(ref));

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
            const events = await this.readEvents({ aggregateId, aggregateType }, 1, undefined, 'read');
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
            await this.cache.clear();
        } catch (err) {
            console.error('Failed to clear cache:', err);
        }
    }

    /**
     * Clear cache for specific aggregate
     */
    async clearAggregateCache(aggregateId: string, aggregateType: string): Promise<void> {
        await this.cache.dropAggregate({ aggregateId, aggregateType });
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
        const service = this.config.cacheService;
        const stats: {
            enabled: boolean;
            type: string;
            info?: {
                keys: number;
                memory: string;
            };
        } = {
            enabled: this.cache.enabled,
            type: service.constructor.name,
        };

        if (service instanceof MemoryCacheService) {
            stats.info = {
                keys: service.size,
                memory: formatBytes(service.sizeBytes),
            };
        } else if (service instanceof RedisCacheService) {
            try {
                const keys = await service.countKeys(this.cache.pattern());
                const info = await service.getRedisClient().info?.('memory') ?? '';
                const memoryMatch = info.match(/used_memory_human:([^\r\n]+)/);

                stats.info = {
                    keys,
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
     * Events of an aggregate within [from, to], served from the stream cache where possible
     */
    private async readEvents(
        ref: AggregateRef,
        from: number,
        to: number | undefined,
        freshness: Freshness
    ): Promise<EventRecord[]> {
        if (to !== undefined && to < from) return [];

        const key = `events|${this.cache.streamKey(ref)}|${from}|${to ?? ''}|${freshness}`;

        if (!this.cache.enabled) {
            return this.flights.run(key, () => this.loadEvents(ref, from, to));
        }

        return this.flights.run(key, async () => {
            const entry = await this.syncStream(ref, from, to, freshness);
            return sliceStream(entry, from, to);
        });
    }

    /**
     * Make sure the cached stream covers [from, to] and is recent enough.
     * Only missing parts are loaded: a prefix before the cached range and/or new events after it.
     */
    private async syncStream(
        ref: AggregateRef,
        from: number,
        to: number | undefined,
        freshness: Freshness
    ): Promise<StreamEntry> {
        const key = this.cache.streamKey(ref);
        const generation = this.cache.generation(ref);
        const cached = await this.cache.getStream(ref);

        if (!cached) {
            const events = await this.loadEvents(ref, from, to);
            const entry = { from, to: lastSequence(events, from - 1), events };
            if (to === undefined) this.cache.markSynced(key);
            await this.cache.putStream(ref, entry, generation);
            return entry;
        }

        const needsPrefix = from < cached.from;
        const needsDelta = (to === undefined || to > cached.to) && !this.cache.isFresh(key, freshness);
        if (!needsPrefix && !needsDelta) return cached;

        const [prefix, delta] = await Promise.all([
            needsPrefix ? this.loadEvents(ref, from, cached.from - 1) : undefined,
            needsDelta ? this.fetchEvents(ref, cached.to + 1, undefined) : undefined,
        ]);

        let entry = cached;
        if (prefix) {
            entry = { from, to: cached.to, events: [...prefix, ...cached.events] };
        }
        if (delta) {
            this.cache.markSynced(key);
            for (const event of delta) entry.events.push(event);
            entry.to = lastSequence(delta, entry.to);
        }

        if (prefix || delta?.length) {
            await this.cache.putStream(ref, entry, generation);
        }

        return entry;
    }

    /**
     * Latest snapshot plus the events after it (up to `to`), for state reconstruction
     */
    private async loadReplaySource(ref: AggregateRef, to?: number): Promise<LoadedStream> {
        return this.flights.run(`replay|${this.cache.streamKey(ref)}|${to ?? ''}`, async () => {
            const head = await this.cache.getHead(ref);

            if (!head) {
                const generation = this.cache.generation(ref);
                const loaded = await this.fetchReplaySource(ref, to);

                if (this.cache.enabled) {
                    const from = loaded.snapshot ? loaded.snapshot.sequence_number + 1 : 1;
                    if (to === undefined) await this.cache.putHead(ref, loaded.snapshot);
                    await this.cache.mergeStream(
                        ref,
                        { from, to: lastSequence(loaded.events, from - 1), events: loaded.events },
                        generation,
                        to === undefined
                    );
                }

                return loaded;
            }

            // Any snapshot is a valid starting point, so the cached one is used without checking for newer ones
            let snapshot = head.snapshot;
            if (snapshot && to !== undefined && snapshot.sequence_number > to) {
                snapshot = await this.config.snapshotRepository.findSnapshotAtSequence(ref.aggregateId, ref.aggregateType, to);
            }

            const from = snapshot ? snapshot.sequence_number + 1 : 1;
            const entry = await this.syncStream(ref, from, to, 'replay');

            return { snapshot, events: sliceStream(entry, from, to) };
        });
    }

    /**
     * Load snapshot and events from the database: one round trip with the database function, two without
     */
    private async fetchReplaySource(ref: AggregateRef, to?: number): Promise<LoadedStream> {
        const loaded = await this.config.eventRepository.loadStream?.({
            aggregateId: ref.aggregateId,
            aggregateType: ref.aggregateType,
            toSequence: to,
            withSnapshot: true,
        });
        if (loaded) return loaded;

        const snapshot = to === undefined
            ? await this.config.snapshotRepository.findLatestSnapshot(ref.aggregateId, ref.aggregateType)
            : await this.config.snapshotRepository.findSnapshotAtSequence(ref.aggregateId, ref.aggregateType, to);
        const from = snapshot ? snapshot.sequence_number + 1 : 1;

        return { snapshot, events: await this.fetchEvents(ref, from, to) };
    }

    /**
     * Load a possibly long range of events: one round trip with the database function,
     * otherwise one request per page
     */
    private async loadEvents(ref: AggregateRef, from: number, to: number | undefined): Promise<EventRecord[]> {
        const loaded = await this.config.eventRepository.loadStream?.({
            aggregateId: ref.aggregateId,
            aggregateType: ref.aggregateType,
            fromSequence: from,
            toSequence: to,
        });
        return loaded ? loaded.events : this.fetchEvents(ref, from, to);
    }

    private fetchEvents(ref: AggregateRef, from: number, to: number | undefined): Promise<EventRecord[]> {
        return this.config.eventRepository.findEvents({
            aggregate_id: ref.aggregateId,
            aggregate_type: ref.aggregateType,
            from_sequence: from,
            to_sequence: to,
            order: 'asc',
        });
    }

    /**
     * Latest snapshot, checking the database for a newer one unless the cached one is fresh enough
     */
    private async syncHead(ref: AggregateRef): Promise<SnapshotRecord | null> {
        const key = this.cache.headKey(ref);
        const head = await this.cache.getHead(ref);
        if (head && this.cache.isFresh(key, 'read')) return head.snapshot;

        const repository = this.config.snapshotRepository;
        let snapshot: SnapshotRecord | null;

        if (head?.snapshot && repository.findLatestSnapshotAfter) {
            // Transfers the (possibly large) state only if there is a newer snapshot
            const newer = await repository.findLatestSnapshotAfter(ref.aggregateId, ref.aggregateType, head.snapshot.sequence_number);
            snapshot = newer ?? head.snapshot;
        } else {
            snapshot = await repository.findLatestSnapshot(ref.aggregateId, ref.aggregateType);
        }

        this.cache.markSynced(key);
        if (!head || snapshot !== head.snapshot) {
            await this.cache.putHead(ref, snapshot);
        }

        return snapshot;
    }

    private async loadStats(ref: AggregateRef): Promise<AggregateStatsData> {
        if (this.cache.cachesDerivedValues) {
            const cached = await this.cache.getStats(ref);
            if (cached) return cached;
        }

        // Prefer a complete cached stream; otherwise let the database aggregate instead of transferring every event
        const entry = await this.cache.getStream(ref);
        let stats = entry?.from === 1
            ? undefined
            : await this.config.eventRepository.getAggregateStats?.(ref.aggregateId, ref.aggregateType);

        if (!stats) {
            stats = computeStats(await this.readEvents(ref, 1, undefined, 'read'));
        }

        if (this.cache.cachesDerivedValues) {
            await this.cache.putStats(ref, stats);
        }

        return stats;
    }

    private async saveSnapshots(ref: AggregateRef, snapshots: CreateSnapshotInput[]): Promise<void> {
        const repository = this.config.snapshotRepository;
        let saved: SnapshotRecord[];

        if (repository.saveSnapshots) {
            saved = await repository.saveSnapshots(snapshots);
        } else {
            saved = [];
            for (const snapshot of snapshots) {
                saved.push(await repository.saveSnapshot(snapshot));
            }
        }

        const latest = saved.reduce<SnapshotRecord | null>(
            (max, snapshot) => !max || snapshot.sequence_number > max.sequence_number ? snapshot : max,
            null
        );
        if (latest) await this.cache.offerHead(ref, latest);
    }

    /**
     * Reserve sequence numbers for multiple aggregates (fallback without atomic append)
     */
    private async reserveSequences(
        events: CreateEventInput[]
    ): Promise<Array<{ event: CreateEventInput; sequenceNumber: number }>> {
        const counts = new Map<string, { aggregateId: string; aggregateType: string; count: number }>();
        for (const event of events) {
            const key = aggregateKey(event.aggregate_id, event.aggregate_type);
            const group = counts.get(key) ?? { aggregateId: event.aggregate_id, aggregateType: event.aggregate_type, count: 0 };
            group.count++;
            counts.set(key, group);
        }

        const nextSequence = new Map<string, number>();
        await Promise.all(
            Array.from(counts, async ([key, group]) => {
                const startSequence = await this.config.sequenceRepository.getNextSequence(
                    group.aggregateId,
                    group.aggregateType,
                    group.count
                );
                nextSequence.set(key, startSequence);
            })
        );

        return events.map(event => {
            const key = aggregateKey(event.aggregate_id, event.aggregate_type);
            const sequenceNumber = nextSequence.get(key)!;
            nextSequence.set(key, sequenceNumber + 1);
            return { event, sequenceNumber };
        });
    }
}

function aggregateKey(aggregateId: string, aggregateType: string): string {
    return JSON.stringify([aggregateId, aggregateType]);
}

function computeStats(events: EventRecord[]): AggregateStatsData {
    const eventTypes = new Map<string, number>();
    for (const event of events) {
        eventTypes.set(event.type, (eventTypes.get(event.type) ?? 0) + 1);
    }

    return {
        totalEvents: events.length,
        firstEvent: events[0] ?? null,
        lastEvent: events[events.length - 1] ?? null,
        eventTypes: Array.from(eventTypes.entries()),
    };
}

function formatBytes(bytes: number): string {
    const units = ['B', 'K', 'M', 'G'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value.toFixed(2)}${units[unit]}`;
}

// ============================================================================
// FACTORY - Builder for Event Store with Supabase
// ============================================================================

/**
 * Event Store Builder Configuration
 */
export interface EventStoreBuilderConfig {
    supabase: SupabaseClient<any, any, any>;
    redis?: RedisClientLike; // Shared cache; without it an in-memory cache is used
    cache?: CacheConfig;
    enablePublisher?: boolean;
    rpc?: boolean | 'auto'; // Use the database functions from sql/eventstore.sql (default: 'auto')
    pageSize?: number; // Rows per request when paginating, at most PostgREST's max-rows (default: 1000)
    projections?: readonly ProjectionDefinition[]; // Projections keeping read models up to date
    readModelStore?: IReadModelStore; // Default store of read models (default: tables in Supabase)
    projectionOptions?: ProjectionOptions;
}

/**
 * Factory function to create Event Store with Supabase adapters
 */
export function createEventStore(config: EventStoreBuilderConfig): EventStore {
    const adapterOptions = { rpc: config.rpc ?? 'auto', pageSize: config.pageSize };
    const eventRepository = new SupabaseEventRepository(config.supabase, adapterOptions);
    const sequenceRepository = new SupabaseSequenceRepository(config.supabase);
    const snapshotRepository = new SupabaseSnapshotRepository(config.supabase, adapterOptions);

    const redis = config.redis ?? config.cache?.redis;
    const cacheService = config.cache?.enabled === false
        ? new NoOpCacheService()
        : redis
            ? new RedisCacheService(redis, config.cache)
            : new MemoryCacheService(config.cache?.memory);

    const eventPublisher = config.enablePublisher
        ? new SupabaseEventPublisher(config.supabase)
        : undefined;

    return new EventStore({
        eventRepository,
        sequenceRepository,
        snapshotRepository,
        cacheService,
        eventPublisher,
        cache: config.cache,
        readModelStore: config.readModelStore ?? new SupabaseReadModelStore(config.supabase, { pageSize: config.pageSize }),
        projections: config.projections,
        projectionOptions: config.projectionOptions,
    });
}

// Default export
export default EventStore;
