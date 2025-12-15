import { SupabaseClient } from '@supabase/supabase-js';
import { Redis } from 'ioredis';
import {
    CacheConfig,
    CreateEventInput,
    CreateSnapshotInput,
    EventProjection,
    EventRecord,
    EventStoreError,
    QueryEventsOptions,
    ReplayOptions,
    SnapshotRecord
} from "../domain";

/**
 * Supabase Event Store
 *
 * A generalized event store implementation for Supabase with optimized performance
 * and support for event sourcing patterns.
 */
export class SupabaseEventStore {
    private readonly EVENTS_TABLE = 'events';
    private readonly SEQUENCES_TABLE = 'aggregate_sequences';
    private readonly SNAPSHOTS_TABLE = 'snapshots';

    private readonly cache: {
        enabled: boolean;
        redis?: Redis;
        ttl: {
            events: number;
            snapshots: number;
            sequences: number;
            aggregateEvents: number;
        };
        keyPrefix: string;
    };

    constructor(
        private readonly supabase: SupabaseClient,
        cacheConfig: CacheConfig = {}
    ) {
        this.cache = {
            enabled: cacheConfig.enabled ?? !!cacheConfig.redis,
            redis: cacheConfig.redis,
            ttl: {
                events: cacheConfig.ttl?.events ?? 3600,
                snapshots: cacheConfig.ttl?.snapshots ?? 7200,
                sequences: cacheConfig.ttl?.sequences ?? 300,
                aggregateEvents: cacheConfig.ttl?.aggregateEvents ?? 1800,
            },
            keyPrefix: cacheConfig.keyPrefix ?? 'es:',
        };
    }

    // ============================================================================
    // CACHE UTILITIES
    // ============================================================================

    /**
     * Generate cache key
     */
    private cacheKey(...parts: string[]): string {
        return `${this.cache.keyPrefix}${parts.join(':')}`;
    }

    /**
     * Get from cache
     */
    private async getCached<T>(key: string): Promise<T | null> {
        if (!this.cache.enabled || !this.cache.redis) return null;

        try {
            const data = await this.cache.redis.get(key);
            return data ? JSON.parse(data) : null;
        } catch (err) {
            console.error('Cache read error:', err);
            return null;
        }
    }

    /**
     * Set in cache
     */
    private async setCached<T>(key: string, value: T, ttl: number): Promise<void> {
        if (!this.cache.enabled || !this.cache.redis) return;

        try {
            await this.cache.redis.setex(key, ttl, JSON.stringify(value));
        } catch (err) {
            console.error('Cache write error:', err);
        }
    }

    /**
     * Delete from cache
     */
    private async deleteCached(key: string): Promise<void> {
        if (!this.cache.enabled || !this.cache.redis) return;

        try {
            await this.cache.redis.del(key);
        } catch (err) {
            console.error('Cache delete error:', err);
        }
    }

    /**
     * Delete multiple keys matching pattern
     */
    private async deleteCachedPattern(pattern: string): Promise<void> {
        if (!this.cache.enabled || !this.cache.redis) return;

        try {
            const keys = await this.cache.redis.keys(pattern);
            if (keys.length > 0) {
                await this.cache.redis.del(...keys);
            }
        } catch (err) {
            console.error('Cache pattern delete error:', err);
        }
    }

    /**
     * Invalidate all cache for an aggregate
     */
    private async invalidateAggregateCache(
        aggregateId: string,
        aggregateType: string
    ): Promise<void> {
        if (!this.cache.enabled || !this.cache.redis) return;

        const patterns = [
            this.cacheKey('agg', aggregateType, aggregateId, '*'),
            this.cacheKey('snapshot', aggregateType, aggregateId, '*'),
            this.cacheKey('seq', aggregateType, aggregateId),
            this.cacheKey('stats', aggregateType, aggregateId),
        ];

        await Promise.all(patterns.map(p => this.deleteCachedPattern(p)));
    }

    /**
     * Get multiple values from cache using pipeline
     */
    private async getCachedMultiple<T>(keys: string[]): Promise<Map<string, T>> {
        if (!this.cache.enabled || !this.cache.redis || keys.length === 0) {
            return new Map();
        }

        try {
            const pipeline = this.cache.redis.pipeline();
            keys.forEach(key => pipeline.get(key));
            const results = await pipeline.exec();

            const map = new Map<string, T>();
            results?.forEach((result, index) => {
                if (result && result[1]) {
                    try {
                        map.set(keys[index], JSON.parse(result[1] as string));
                    } catch {
                        // Skip invalid JSON
                    }
                }
            });

            return map;
        } catch (err) {
            console.error('Cache multi-read error:', err);
            return new Map();
        }
    }

    /**
     * Set multiple values in cache using pipeline
     */
    private async setCachedMultiple<T>(
        entries: Array<{ key: string; value: T; ttl: number }>
    ): Promise<void> {
        if (!this.cache.enabled || !this.cache.redis || entries.length === 0) return;

        try {
            const pipeline = this.cache.redis.pipeline();
            entries.forEach(({ key, value, ttl }) => {
                pipeline.setex(key, ttl, JSON.stringify(value));
            });
            await pipeline.exec();
        } catch (err) {
            console.error('Cache multi-write error:', err);
        }
    }

    /**
     * Append a single event to the event store
     *
     * @param event - Event to append
     * @returns The created event record
     */
    async appendEvent(event: CreateEventInput): Promise<EventRecord> {
        try {
            // Get next sequence number
            const sequenceNumber = await this.getNextSequenceNumber(
                event.aggregate_id,
                event.aggregate_type
            );

            // Insert event
            const { data, error } = await this.supabase
                .from(this.EVENTS_TABLE)
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

            if (error) {
                throw new EventStoreError(`Failed to append event: ${error.message}`, error);
            }

            const eventRecord = data as EventRecord;

            // Invalidate cache for this aggregate
            await this.invalidateAggregateCache(
                event.aggregate_id,
                event.aggregate_type
            );

            return eventRecord;
        } catch (err) {
            if (err instanceof EventStoreError) throw err;
            throw new EventStoreError('Failed to append event', err);
        }
    }

    /**
     * Append multiple events atomically
     *
     * @param events - Events to append
     * @returns Array of created event records
     */
    async appendEvents(events: CreateEventInput[]): Promise<EventRecord[]> {
        if (events.length === 0) return [];

        try {
            // Group events by aggregate
            const eventsByAggregate = new Map<string, CreateEventInput[]>();

            for (const event of events) {
                const key = `${event.aggregate_id}:${event.aggregate_type}`;
                const group = eventsByAggregate.get(key) ?? [];
                group.push(event);
                eventsByAggregate.set(key, group);
            }

            // Get sequence numbers for each aggregate
            const sequencePromises = Array.from(eventsByAggregate.entries()).map(
                async ([key, evts]) => {
                    const [aggregateId, aggregateType] = key.split(':');
                    const startSequence = await this.getNextSequenceNumber(
                        aggregateId,
                        aggregateType,
                        evts.length
                    );
                    return { key, startSequence };
                }
            );

            const sequences = await Promise.all(sequencePromises);
            const sequenceMap = new Map(
                sequences.map(s => [s.key, s.startSequence])
            );

            // Prepare events with sequence numbers
            const eventsToInsert = events.map((event, idx) => {
                const key = `${event.aggregate_id}:${event.aggregate_type}`;
                const groupEvents = eventsByAggregate.get(key)!;
                const indexInGroup = groupEvents.indexOf(event);
                const startSequence = sequenceMap.get(key)!;

                return {
                    type: event.type,
                    aggregate_id: event.aggregate_id,
                    aggregate_type: event.aggregate_type,
                    sequence_number: startSequence + indexInGroup,
                    version: event.version ?? 1,
                    payload: event.payload ?? {},
                    metadata: event.metadata ?? {},
                    created_by: event.created_by,
                };
            });

            // Insert all events
            const { data, error } = await this.supabase
                .from(this.EVENTS_TABLE)
                .insert(eventsToInsert)
                .select();

            if (error) {
                throw new EventStoreError(`Failed to append events: ${error.message}`, error);
            }

            const eventRecords = data as EventRecord[];

            // Invalidate cache for all affected aggregates
            const invalidations = Array.from(eventsByAggregate.keys()).map(key => {
                const [aggregateId, aggregateType] = key.split(':');
                return this.invalidateAggregateCache(aggregateId, aggregateType);
            });
            await Promise.all(invalidations);

            return eventRecords;
        } catch (err) {
            if (err instanceof EventStoreError) throw err;
            throw new EventStoreError('Failed to append events', err);
        }
    }

    /**
     * Query events from the event store
     *
     * @param options - Query options
     * @returns Array of event records
     */
    async queryEvents(options: QueryEventsOptions = {}): Promise<EventRecord[]> {
        try {
            let query = this.supabase
                .from(this.EVENTS_TABLE)
                .select('*');

            if (options.aggregate_id) {
                query = query.eq('aggregate_id', options.aggregate_id);
            }

            if (options.aggregate_type) {
                query = query.eq('aggregate_type', options.aggregate_type);
            }

            if (options.type) {
                query = query.eq('type', options.type);
            }

            if (options.from_sequence !== undefined) {
                query = query.gte('sequence_number', options.from_sequence);
            }

            if (options.to_sequence !== undefined) {
                query = query.lte('sequence_number', options.to_sequence);
            }

            query = query.order('sequence_number', {
                ascending: options.order !== 'desc',
            });

            if (options.limit) {
                query = query.limit(options.limit);
            }

            const { data, error } = await query;

            if (error) {
                throw new EventStoreError(`Failed to query events: ${error.message}`, error);
            }

            return (data as EventRecord[]) ?? [];
        } catch (err) {
            if (err instanceof EventStoreError) throw err;
            throw new EventStoreError('Failed to query events', err);
        }
    }

    /**
     * Get events for a specific aggregate
     *
     * @param aggregateId - Aggregate ID
     * @param aggregateType - Aggregate type
     * @param fromSequence - Optional starting sequence number
     * @returns Array of event records
     */
    async getAggregateEvents(
        aggregateId: string,
        aggregateType: string,
        fromSequence?: number
    ): Promise<EventRecord[]> {
        const cacheKey = this.cacheKey(
            'agg',
            aggregateType,
            aggregateId,
            fromSequence?.toString() ?? 'all'
        );

        // Try cache first
        const cached = await this.getCached<EventRecord[]>(cacheKey);
        if (cached) return cached;

        // Fetch from database
        const events = await this.queryEvents({
            aggregate_id: aggregateId,
            aggregate_type: aggregateType,
            from_sequence: fromSequence,
            order: 'asc',
        });

        // Cache the result
        await this.setCached(cacheKey, events, this.cache.ttl.aggregateEvents);

        return events;
    }

    /**
     * Get events by type
     *
     * @param type - Event type
     * @param limit - Optional limit
     * @returns Array of event records
     */
    async getEventsByType(type: string, limit?: number): Promise<EventRecord[]> {
        return this.queryEvents({
            type,
            limit,
            order: 'desc',
        });
    }

    /**
     * Get the latest event for an aggregate
     *
     * @param aggregateId - Aggregate ID
     * @param aggregateType - Aggregate type
     * @returns The latest event or null
     */
    async getLatestEvent(
        aggregateId: string,
        aggregateType: string
    ): Promise<EventRecord | null> {
        const events = await this.queryEvents({
            aggregate_id: aggregateId,
            aggregate_type: aggregateType,
            order: 'desc',
            limit: 1,
        });

        return events[0] ?? null;
    }

    /**
     * Get current sequence number for an aggregate
     *
     * @param aggregateId - Aggregate ID
     * @param aggregateType - Aggregate type
     * @returns Current sequence number
     */
    async getCurrentSequenceNumber(
        aggregateId: string,
        aggregateType: string
    ): Promise<number> {
        const cacheKey = this.cacheKey('seq', aggregateType, aggregateId);

        // Try cache first
        const cached = await this.getCached<number>(cacheKey);
        if (cached !== null) return cached;

        // Fetch from database
        const { data, error } = await this.supabase
            .from(this.SEQUENCES_TABLE)
            .select('last_sequence')
            .eq('aggregate_id', aggregateId)
            .eq('aggregate_type', aggregateType)
            .single();

        if (error && error.code !== 'PGRST116') {
            throw new EventStoreError(
                `Failed to get sequence number: ${error.message}`,
                error
            );
        }

        const sequence = data?.last_sequence ?? 0;

        // Cache the result
        await this.setCached(cacheKey, sequence, this.cache.ttl.sequences);

        return sequence;
    }

    /**
     * Get and increment the next sequence number(s) atomically
     *
     * @param aggregateId - Aggregate ID
     * @param aggregateType - Aggregate type
     * @param count - Number of sequence numbers to reserve (default: 1)
     * @returns Next sequence number
     */
    private async getNextSequenceNumber(
        aggregateId: string,
        aggregateType: string,
        count: number = 1
    ): Promise<number> {
        try {
            // Invalidate sequence cache immediately
            const cacheKey = this.cacheKey('seq', aggregateType, aggregateId);
            await this.deleteCached(cacheKey);

            // Use upsert to atomically increment or create
            const { data: currentData } = await this.supabase
                .from(this.SEQUENCES_TABLE)
                .select('last_sequence')
                .eq('aggregate_id', aggregateId)
                .eq('aggregate_type', aggregateType)
                .single();

            const currentSequence = currentData?.last_sequence ?? 0;
            const nextSequence = currentSequence + count;

            const { error } = await this.supabase
                .from(this.SEQUENCES_TABLE)
                .upsert({
                    aggregate_id: aggregateId,
                    aggregate_type: aggregateType,
                    last_sequence: nextSequence,
                });

            if (error) {
                throw new EventStoreError(
                    `Failed to update sequence: ${error.message}`,
                    error
                );
            }

            // Update cache with new sequence
            await this.setCached(cacheKey, nextSequence, this.cache.ttl.sequences);

            return currentSequence + 1;
        } catch (err) {
            if (err instanceof EventStoreError) throw err;
            throw new EventStoreError('Failed to get next sequence number', err);
        }
    }

    /**
     * Stream events in real-time
     *
     * @param callback - Callback function for new events
     * @param options - Optional query options for filtering
     * @returns Unsubscribe function
     */
    subscribeToEvents(
        callback: (event: EventRecord) => void,
        options: Omit<QueryEventsOptions, 'limit' | 'order'> = {}
    ): () => void {
        let channel = this.supabase
            .channel('events-changes')
            .on(
                'postgres_changes',
                {
                    event: 'INSERT',
                    schema: 'public',
                    table: this.EVENTS_TABLE,
                    filter: this.buildRealtimeFilter(options),
                },
                (payload) => {
                    callback(payload.new as EventRecord);
                }
            )
            .subscribe();

        return () => {
            channel.unsubscribe();
        };
    }

    /**
     * Build realtime filter string from query options
     */
    private buildRealtimeFilter(options: Omit<QueryEventsOptions, 'limit' | 'order'>): string | undefined {
        const filters: string[] = [];

        if (options.aggregate_id) {
            filters.push(`aggregate_id=eq.${options.aggregate_id}`);
        }

        if (options.aggregate_type) {
            filters.push(`aggregate_type=eq.${options.aggregate_type}`);
        }

        if (options.type) {
            filters.push(`type=eq.${options.type}`);
        }

        return filters.length > 0 ? filters.join(',') : undefined;
    }

    // ============================================================================
    // SNAPSHOT MANAGEMENT
    // ============================================================================

    /**
     * Create a snapshot of an aggregate's current state
     *
     * @param snapshot - Snapshot data
     * @returns Created snapshot record
     */
    async createSnapshot(snapshot: CreateSnapshotInput): Promise<SnapshotRecord> {
        try {
            const { data, error } = await this.supabase
                .from(this.SNAPSHOTS_TABLE)
                .insert({
                    aggregate_id: snapshot.aggregate_id,
                    aggregate_type: snapshot.aggregate_type,
                    sequence_number: snapshot.sequence_number,
                    state: snapshot.state,
                    version: snapshot.version ?? 1,
                })
                .select()
                .single();

            if (error) {
                throw new EventStoreError(`Failed to create snapshot: ${error.message}`, error);
            }

            const snapshotRecord = data as SnapshotRecord;

            // Cache the snapshot
            const cacheKey = this.cacheKey(
                'snapshot',
                snapshot.aggregate_type,
                snapshot.aggregate_id,
                'latest'
            );
            await this.setCached(cacheKey, snapshotRecord, this.cache.ttl.snapshots);

            return snapshotRecord;
        } catch (err) {
            if (err instanceof EventStoreError) throw err;
            throw new EventStoreError('Failed to create snapshot', err);
        }
    }

    /**
     * Get the latest snapshot for an aggregate
     *
     * @param aggregateId - Aggregate ID
     * @param aggregateType - Aggregate type
     * @returns Latest snapshot or null
     */
    async getLatestSnapshot(
        aggregateId: string,
        aggregateType: string
    ): Promise<SnapshotRecord | null> {
        const cacheKey = this.cacheKey('snapshot', aggregateType, aggregateId, 'latest');

        // Try cache first
        const cached = await this.getCached<SnapshotRecord>(cacheKey);
        if (cached) return cached;

        try {
            const { data, error } = await this.supabase
                .from(this.SNAPSHOTS_TABLE)
                .select('*')
                .eq('aggregate_id', aggregateId)
                .eq('aggregate_type', aggregateType)
                .order('sequence_number', { ascending: false })
                .limit(1)
                .single();

            if (error && error.code !== 'PGRST116') {
                throw new EventStoreError(`Failed to get snapshot: ${error.message}`, error);
            }

            const snapshot = (data as SnapshotRecord) ?? null;

            // Cache the result (including null to prevent repeated DB queries)
            if (snapshot) {
                await this.setCached(cacheKey, snapshot, this.cache.ttl.snapshots);
            }

            return snapshot;
        } catch (err) {
            if (err instanceof EventStoreError) throw err;
            throw new EventStoreError('Failed to get snapshot', err);
        }
    }

    /**
     * Get a specific snapshot by sequence number
     *
     * @param aggregateId - Aggregate ID
     * @param aggregateType - Aggregate type
     * @param sequenceNumber - Sequence number
     * @returns Snapshot or null
     */
    async getSnapshotAtSequence(
        aggregateId: string,
        aggregateType: string,
        sequenceNumber: number
    ): Promise<SnapshotRecord | null> {
        try {
            const { data, error } = await this.supabase
                .from(this.SNAPSHOTS_TABLE)
                .select('*')
                .eq('aggregate_id', aggregateId)
                .eq('aggregate_type', aggregateType)
                .lte('sequence_number', sequenceNumber)
                .order('sequence_number', { ascending: false })
                .limit(1)
                .single();

            if (error && error.code !== 'PGRST116') {
                throw new EventStoreError(`Failed to get snapshot: ${error.message}`, error);
            }

            return (data as SnapshotRecord) ?? null;
        } catch (err) {
            if (err instanceof EventStoreError) throw err;
            throw new EventStoreError('Failed to get snapshot at sequence', err);
        }
    }

    /**
     * Delete old snapshots, keeping only the N most recent
     *
     * @param aggregateId - Aggregate ID
     * @param aggregateType - Aggregate type
     * @param keepCount - Number of snapshots to keep (default: 3)
     * @returns Number of deleted snapshots
     */
    async pruneSnapshots(
        aggregateId: string,
        aggregateType: string,
        keepCount: number = 3
    ): Promise<number> {
        try {
            // Get snapshots to delete
            const { data: snapshots } = await this.supabase
                .from(this.SNAPSHOTS_TABLE)
                .select('id, sequence_number')
                .eq('aggregate_id', aggregateId)
                .eq('aggregate_type', aggregateType)
                .order('sequence_number', { ascending: false });

            if (!snapshots || snapshots.length <= keepCount) {
                return 0;
            }

            const toDelete = snapshots.slice(keepCount);
            const idsToDelete = toDelete.map(s => s.id);

            const { error } = await this.supabase
                .from(this.SNAPSHOTS_TABLE)
                .delete()
                .in('id', idsToDelete);

            if (error) {
                throw new EventStoreError(`Failed to prune snapshots: ${error.message}`, error);
            }

            return toDelete.length;
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
     *
     * @param aggregateId - Aggregate ID
     * @param aggregateType - Aggregate type
     * @param projection - Projection defining how to apply events
     * @param options - Replay options
     * @returns Final state after applying all events
     */
    async replayEvents<T>(
        aggregateId: string,
        aggregateType: string,
        projection: EventProjection<T>,
        options: ReplayOptions = {}
    ): Promise<T> {
        try {
            // Try to load from snapshot first
            let state = projection.initialState;
            let fromSequence = options.from_sequence ?? 1;

            if (!options.from_sequence) {
                const snapshot = await this.getLatestSnapshot(aggregateId, aggregateType);
                if (snapshot) {
                    state = snapshot.state;
                    fromSequence = snapshot.sequence_number + 1;
                }
            }

            // Get events to replay
            const events = await this.queryEvents({
                aggregate_id: aggregateId,
                aggregate_type: aggregateType,
                from_sequence: fromSequence,
                to_sequence: options.to_sequence,
                order: 'asc',
            });

            // Apply events to state
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
     * Useful for large event streams and rebuilding read models
     *
     * @param options - Query options for filtering events
     * @param batchCallback - Callback invoked for each batch of events
     * @param batchSize - Number of events per batch (default: 100)
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

                if (events.length === 0) {
                    hasMore = false;
                    break;
                }

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
     *
     * @param aggregateId - Aggregate ID
     * @param aggregateType - Aggregate type
     * @param projection - Projection defining how to apply events
     * @param snapshotInterval - Create snapshot every N events (default: 50)
     * @returns Final state
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

            // Get latest snapshot
            const snapshot = await this.getLatestSnapshot(aggregateId, aggregateType);
            if (snapshot) {
                state = snapshot.state;
                lastSnapshotSequence = snapshot.sequence_number;
            }

            // Get events since last snapshot
            const events = await this.queryEvents({
                aggregate_id: aggregateId,
                aggregate_type: aggregateType,
                from_sequence: lastSnapshotSequence + 1,
                order: 'asc',
            });

            // Apply events and create snapshots periodically
            for (let i = 0; i < events.length; i++) {
                const event = events[i];
                state = projection.applyEvent(state, event);

                // Create snapshot at intervals
                if ((i + 1) % snapshotInterval === 0) {
                    await this.createSnapshot({
                        aggregate_id: aggregateId,
                        aggregate_type: aggregateType,
                        sequence_number: event.sequence_number,
                        state: state,
                    });
                }
            }

            // Create final snapshot if we processed events
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
     *
     * @param aggregateId - Aggregate ID
     * @param aggregateType - Aggregate type
     * @param projection - Projection defining how to apply events
     * @param sequenceNumber - Sequence number to replay up to
     * @returns State at the specified sequence
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
     *
     * @param aggregateId - Aggregate ID
     * @param aggregateType - Aggregate type
     * @returns Statistics object
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
        const cacheKey = this.cacheKey('stats', aggregateType, aggregateId);

        // Try cache first
        const cached = await this.getCached<{
            totalEvents: number;
            firstEvent: EventRecord | null;
            lastEvent: EventRecord | null;
            eventTypes: Array<[string, number]>;
        }>(cacheKey);

        if (cached) {
            return {
                ...cached,
                eventTypes: new Map(cached.eventTypes),
            };
        }

        try {
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

            // Cache the stats
            await this.setCached(cacheKey, stats, this.cache.ttl.aggregateEvents);

            return {
                ...stats,
                eventTypes: new Map(stats.eventTypes),
            };
        } catch (err) {
            if (err instanceof EventStoreError) throw err;
            throw new EventStoreError('Failed to get aggregate stats', err);
        }
    }

    /**
     * Validate event stream consistency for an aggregate
     *
     * @param aggregateId - Aggregate ID
     * @param aggregateType - Aggregate type
     * @returns Validation result with any issues found
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

            // Check sequence continuity
            for (let i = 0; i < events.length; i++) {
                const expectedSequence = i + 1;
                if (events[i].sequence_number !== expectedSequence) {
                    issues.push(
                        `Sequence gap detected: expected ${expectedSequence}, got ${events[i].sequence_number}`
                    );
                }
            }

            // Check aggregate consistency
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
        if (!this.cache.enabled || !this.cache.redis) return;

        try {
            const pattern = `${this.cache.keyPrefix}*`;
            await this.deleteCachedPattern(pattern);
        } catch (err) {
            console.error('Failed to clear cache:', err);
        }
    }

    /**
     * Clear cache for specific aggregate
     */
    async clearAggregateCache(
        aggregateId: string,
        aggregateType: string
    ): Promise<void> {
        await this.invalidateAggregateCache(aggregateId, aggregateType);
    }

    /**
     * Warm up cache for an aggregate
     * Pre-loads commonly accessed data into cache
     */
    async warmupCache(
        aggregateId: string,
        aggregateType: string
    ): Promise<void> {
        if (!this.cache.enabled) return;

        try {
            // Warm up in parallel
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
        redis: boolean;
        info?: {
            keys: number;
            memory: string;
        };
    }> {
        const stats: any = {
            enabled: this.cache.enabled,
            redis: !!this.cache.redis,
        };

        if (this.cache.redis) {
            try {
                const keys = await this.cache.redis.keys(`${this.cache.keyPrefix}*`);
                const info = await this.cache.redis.info('memory');
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
}

/**
 * Create a new event store instance
 *
 * @param supabase - Supabase client
 * @param cacheConfig - Optional cache configuration
 * @returns Event store instance
 */
export function createEventStore(
    supabase: SupabaseClient,
    cacheConfig?: CacheConfig
): SupabaseEventStore {
    return new SupabaseEventStore(supabase, cacheConfig);
}

// Default export
export default SupabaseEventStore;