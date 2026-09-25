import {
    type AggregateStatsData,
    type CreateEventInput,
    type CreateSnapshotInput,
    type EventRecord,
    type ICacheService,
    type IEventRepository,
    type ISequenceRepository,
    type ISnapshotRepository,
    type LoadedStream,
    MemoryCacheService,
    type QueryEventsOptions,
    type SnapshotRecord,
    type StreamQuery,
} from '../../src/index.js';

/**
 * In-memory database shared by the fake repositories. `calls` records every repository call,
 * which is what the tests use to count database round trips.
 */
export class FakeDatabase {
    events: EventRecord[] = [];
    snapshots: SnapshotRecord[] = [];
    sequences = new Map<string, number>();
    calls: string[] = [];
    private counter = 0;
    private clock = Date.UTC(2026, 0, 1);

    nextId(prefix: string): string {
        return `${prefix}-${String(++this.counter).padStart(6, '0')}`;
    }

    now(): string {
        return new Date(this.clock += 1000).toISOString();
    }

    record(call: string): void {
        this.calls.push(call);
    }

    resetCalls(): string[] {
        const calls = this.calls;
        this.calls = [];
        return calls;
    }

    insertEvent(event: CreateEventInput, sequenceNumber: number): EventRecord {
        const record: EventRecord = {
            id: this.nextId('evt'),
            type: event.type,
            aggregate_id: event.aggregate_id,
            aggregate_type: event.aggregate_type,
            sequence_number: sequenceNumber,
            version: event.version ?? 1,
            payload: event.payload ?? {},
            metadata: event.metadata ?? {},
            created_at: this.now(),
            created_by: event.created_by,
        };
        this.events.push(record);
        return structuredClone(record);
    }

    reserve(aggregateId: string, aggregateType: string, count: number): number {
        const key = JSON.stringify([aggregateId, aggregateType]);
        const current = this.sequences.get(key) ?? 0;
        this.sequences.set(key, current + count);
        return current + 1;
    }

    stream(aggregateId: string, aggregateType: string): EventRecord[] {
        return this.events
            .filter(e => e.aggregate_id === aggregateId && e.aggregate_type === aggregateType)
            .sort((a, b) => a.sequence_number - b.sequence_number || a.id.localeCompare(b.id));
    }
}

export interface Capabilities {
    atomicAppend?: boolean;
    loadStream?: boolean;
    stats?: boolean;
    paging?: boolean;
}

export class FakeEventRepository implements IEventRepository {
    appendEvents?: IEventRepository['appendEvents'];
    loadStream?: IEventRepository['loadStream'];
    getAggregateStats?: IEventRepository['getAggregateStats'];
    findEventsPage?: IEventRepository['findEventsPage'];

    constructor(private readonly db: FakeDatabase, capabilities: Capabilities = {}) {
        const all = { atomicAppend: true, loadStream: true, stats: true, paging: true, ...capabilities };
        if (all.atomicAppend) this.appendEvents = events => this.atomicAppend(events);
        if (all.loadStream) this.loadStream = query => this.load(query);
        if (all.stats) this.getAggregateStats = (id, type) => this.stats(id, type);
        if (all.paging) this.findEventsPage = (options, offset, limit) => this.page(options, offset, limit);
    }

    async saveEvent(event: CreateEventInput, sequenceNumber: number): Promise<EventRecord> {
        this.db.record('saveEvent');
        return this.db.insertEvent(event, sequenceNumber);
    }

    async saveEvents(events: Array<{ event: CreateEventInput; sequenceNumber: number }>): Promise<EventRecord[]> {
        this.db.record('saveEvents');
        return events.map(({event, sequenceNumber}) => this.db.insertEvent(event, sequenceNumber));
    }

    async findEvents(options: QueryEventsOptions): Promise<EventRecord[]> {
        this.db.record(`findEvents(${options.from_sequence ?? ''}..${options.to_sequence ?? ''})`);
        const ascending = options.order !== 'desc';
        const result = this.db.events
            .filter(e => matches(e, options))
            .sort((a, b) => (a.sequence_number - b.sequence_number || a.id.localeCompare(b.id)) * (ascending ? 1 : -1));
        return structuredClone(options.limit ? result.slice(0, options.limit) : result);
    }

    async findEventsByAggregate(aggregateId: string, aggregateType: string, fromSequence?: number): Promise<EventRecord[]> {
        return this.findEvents({ aggregate_id: aggregateId, aggregate_type: aggregateType, from_sequence: fromSequence });
    }

    async findEventsByType(type: string, limit?: number): Promise<EventRecord[]> {
        this.db.record('findEventsByType');
        const result = this.db.events.filter(e => e.type === type).sort((a, b) => b.created_at.localeCompare(a.created_at));
        return structuredClone(limit ? result.slice(0, limit) : result);
    }

    async findLatestEvent(aggregateId: string, aggregateType: string): Promise<EventRecord | null> {
        this.db.record('findLatestEvent');
        return structuredClone(this.db.stream(aggregateId, aggregateType).at(-1) ?? null);
    }

    private async atomicAppend(events: CreateEventInput[]): Promise<EventRecord[]> {
        this.db.record('appendEvents');
        const next = new Map<string, number>();
        const counts = new Map<string, number>();
        for (const e of events) {
            const key = JSON.stringify([e.aggregate_id, e.aggregate_type]);
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        for (const [key, count] of counts) {
            const [id, type] = JSON.parse(key);
            next.set(key, this.db.reserve(id, type, count));
        }
        return events.map(e => {
            const key = JSON.stringify([e.aggregate_id, e.aggregate_type]);
            const sequence = next.get(key)!;
            next.set(key, sequence + 1);
            return this.db.insertEvent(e, sequence);
        });
    }

    private async load(query: StreamQuery): Promise<LoadedStream> {
        this.db.record(query.withSnapshot ? 'loadStream' : `loadStream(${query.fromSequence ?? ''}..${query.toSequence ?? ''})`);
        let from = query.fromSequence ?? 1;
        let snapshot: SnapshotRecord | null = null;
        if (query.withSnapshot) {
            snapshot = this.db.snapshots
                .filter(s => s.aggregate_id === query.aggregateId && s.aggregate_type === query.aggregateType)
                .filter(s => query.toSequence === undefined || s.sequence_number <= query.toSequence)
                .sort((a, b) => b.sequence_number - a.sequence_number)[0] ?? null;
            from = snapshot ? snapshot.sequence_number + 1 : 1;
        }
        const events = this.db.stream(query.aggregateId, query.aggregateType)
            .filter(e => e.sequence_number >= from && (query.toSequence === undefined || e.sequence_number <= query.toSequence));
        return structuredClone({ snapshot, events });
    }

    private async stats(aggregateId: string, aggregateType: string): Promise<AggregateStatsData> {
        this.db.record('getAggregateStats');
        const events = this.db.stream(aggregateId, aggregateType);
        const types = new Map<string, number>();
        for (const e of events) types.set(e.type, (types.get(e.type) ?? 0) + 1);
        return structuredClone({
            totalEvents: events.length,
            firstEvent: events[0] ?? null,
            lastEvent: events.at(-1) ?? null,
            eventTypes: [...types],
        });
    }

    private async page(options: QueryEventsOptions, offset: number, limit: number): Promise<EventRecord[]> {
        this.db.record(`findEventsPage(${offset})`);
        return structuredClone(this.db.events
            .filter(e => matches(e, options))
            .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.sequence_number - b.sequence_number || a.id.localeCompare(b.id))
            .slice(offset, offset + limit));
    }
}

export class FakeSequenceRepository implements ISequenceRepository {
    constructor(private readonly db: FakeDatabase) {}

    async getCurrentSequence(aggregateId: string, aggregateType: string): Promise<number> {
        this.db.record('getCurrentSequence');
        return this.db.sequences.get(JSON.stringify([aggregateId, aggregateType])) ?? 0;
    }

    async getNextSequence(aggregateId: string, aggregateType: string, count = 1): Promise<number> {
        this.db.record('getNextSequence');
        return this.db.reserve(aggregateId, aggregateType, count);
    }
}

export class FakeSnapshotRepository implements ISnapshotRepository {
    saveSnapshots?: ISnapshotRepository['saveSnapshots'];
    findLatestSnapshotAfter?: ISnapshotRepository['findLatestSnapshotAfter'];

    constructor(private readonly db: FakeDatabase, capabilities: { batch?: boolean; after?: boolean } = {}) {
        if (capabilities.batch !== false) {
            this.saveSnapshots = async snapshots => {
                this.db.record('saveSnapshots');
                return snapshots.map(s => this.insert(s));
            };
        }
        if (capabilities.after !== false) {
            this.findLatestSnapshotAfter = async (id, type, after) => {
                this.db.record('findLatestSnapshotAfter');
                return structuredClone(this.forAggregate(id, type).filter(s => s.sequence_number > after)[0] ?? null);
            };
        }
    }

    async saveSnapshot(snapshot: CreateSnapshotInput): Promise<SnapshotRecord> {
        this.db.record('saveSnapshot');
        return this.insert(snapshot);
    }

    async findLatestSnapshot(aggregateId: string, aggregateType: string): Promise<SnapshotRecord | null> {
        this.db.record('findLatestSnapshot');
        return structuredClone(this.forAggregate(aggregateId, aggregateType)[0] ?? null);
    }

    async findSnapshotAtSequence(aggregateId: string, aggregateType: string, sequenceNumber: number): Promise<SnapshotRecord | null> {
        this.db.record('findSnapshotAtSequence');
        return structuredClone(this.forAggregate(aggregateId, aggregateType).filter(s => s.sequence_number <= sequenceNumber)[0] ?? null);
    }

    async deleteOldSnapshots(aggregateId: string, aggregateType: string, keepCount: number): Promise<number> {
        this.db.record('deleteOldSnapshots');
        const doomed = new Set(this.forAggregate(aggregateId, aggregateType).slice(Math.max(0, keepCount)));
        this.db.snapshots = this.db.snapshots.filter(s => !doomed.has(s));
        return doomed.size;
    }

    private insert(snapshot: CreateSnapshotInput): SnapshotRecord {
        const record: SnapshotRecord = {
            id: this.db.nextId('snap'),
            aggregate_id: snapshot.aggregate_id,
            aggregate_type: snapshot.aggregate_type,
            sequence_number: snapshot.sequence_number,
            state: structuredClone(snapshot.state),
            version: snapshot.version ?? 1,
            created_at: this.db.now(),
        };
        this.db.snapshots.push(record);
        return structuredClone(record);
    }

    // Newest first
    private forAggregate(aggregateId: string, aggregateType: string): SnapshotRecord[] {
        return this.db.snapshots
            .filter(s => s.aggregate_id === aggregateId && s.aggregate_type === aggregateType)
            .sort((a, b) => b.sequence_number - a.sequence_number);
    }
}

/**
 * Cache shared between "processes" (like Redis), backed by a single in-memory store
 */
export class SharedCache implements ICacheService {
    readonly scope = 'shared' as const;

    constructor(readonly store = new MemoryCacheService()) {}

    get<T>(key: string) { return this.store.get<T>(key); }
    set<T>(key: string, value: T, ttl: number) { return this.store.set(key, value, ttl); }
    delete(key: string) { return this.store.delete(key); }
    deleteMany(keys: string[]) { return this.store.deleteMany(keys); }
    deletePattern(pattern: string) { return this.store.deletePattern(pattern); }
    getMultiple<T>(keys: string[]) { return this.store.getMultiple<T>(keys); }
    setMultiple<T>(entries: Array<{ key: string; value: T; ttl: number }>) { return this.store.setMultiple(entries); }
}

function matches(event: EventRecord, options: QueryEventsOptions): boolean {
    return (!options.aggregate_id || event.aggregate_id === options.aggregate_id)
        && (!options.aggregate_type || event.aggregate_type === options.aggregate_type)
        && (!options.type || event.type === options.type)
        && (options.from_sequence === undefined || event.sequence_number >= options.from_sequence)
        && (options.to_sequence === undefined || event.sequence_number <= options.to_sequence);
}
