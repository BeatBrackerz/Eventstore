import type {ICacheService, AggregateStatsData} from "../ports/index.js";
import type {CacheConfig, EventRecord, SnapshotRecord} from "../domain/index.js";
import {NoOpCacheService} from "../adapters/NoOpCacheService.js";

export interface AggregateRef {
    aggregateId: string;
    aggregateType: string;
}

/**
 * Cached part of an event stream: all events with sequence numbers in [from, to], ascending.
 *
 * Events are immutable and appended in sequence order, so an entry never becomes wrong; it can
 * only fall behind, and a delta query for sequence numbers above `to` brings it up to date.
 */
export interface StreamEntry {
    from: number;
    to: number;
    events: EventRecord[];
}

/** 'read': plain reads, 'replay': state reconstruction (replays verify by default even with Redis) */
export type Freshness = 'read' | 'replay';

interface LegacyCacheService {
    buildCacheKey?(...parts: string[]): string;
    getTTL?(type: 'snapshots' | 'sequences' | 'aggregateEvents'): number;
}

const DEFAULT_TTL = { snapshots: 7200, sequences: 300, aggregateEvents: 1800 };
const MAX_TRACKED_AGGREGATES = 10_000;

/**
 * Aggregate-level caching on top of an ICacheService: key layout, TTLs, consistency policy
 * and how writes update or invalidate cached data.
 */
export class AggregateCache {
    readonly enabled: boolean;
    private readonly local: boolean;
    private readonly staleness: Record<Freshness, number>;
    private readonly ttl: typeof DEFAULT_TTL;
    private readonly buildKey: (...parts: string[]) => string;

    // Last successful check against the database per key (only needed for finite staleness windows)
    private readonly syncedAt = new Map<string, number>();
    // Bumped on every write so reads that started earlier do not overwrite newer cache entries
    private readonly generations = new Map<string, number>();
    private epoch = 0;

    constructor(private readonly service: ICacheService, config: CacheConfig = {}) {
        const legacy = service as LegacyCacheService;
        this.enabled = config.enabled !== false && !(service instanceof NoOpCacheService);
        this.local = service.scope === 'local';

        const ttl = (type: keyof typeof DEFAULT_TTL) => config.ttl?.[type] ?? legacy.getTTL?.(type) ?? DEFAULT_TTL[type];
        this.ttl = { snapshots: ttl('snapshots'), sequences: ttl('sequences'), aggregateEvents: ttl('aggregateEvents') };

        if (config.keyPrefix === undefined && legacy.buildCacheKey) {
            this.buildKey = (...parts) => legacy.buildCacheKey!(...parts);
        } else {
            const prefix = config.keyPrefix ?? 'es:';
            this.buildKey = (...parts) => prefix + parts.join(':');
        }

        const configured = config.maxStalenessMs;
        if (configured !== undefined) {
            const maxAge = Number.isNaN(configured) ? 0 : Math.max(0, configured);
            this.staleness = { read: maxAge, replay: maxAge };
        } else {
            this.staleness = { read: this.local ? 0 : Infinity, replay: 0 };
        }
    }

    /** Whether values that are only kept current by invalidation (sequence numbers, stats) may be cached */
    get cachesDerivedValues(): boolean {
        return this.enabled && this.staleness.read === Infinity;
    }

    streamKey(ref: AggregateRef): string {
        return this.buildKey('agg', escape(ref.aggregateType), escape(ref.aggregateId), 'stream');
    }

    headKey(ref: AggregateRef): string {
        return this.buildKey('snapshot', escape(ref.aggregateType), escape(ref.aggregateId), 'head');
    }

    sequenceKey(ref: AggregateRef): string {
        return this.buildKey('seq', escape(ref.aggregateType), escape(ref.aggregateId));
    }

    statsKey(ref: AggregateRef): string {
        return this.buildKey('stats', escape(ref.aggregateType), escape(ref.aggregateId));
    }

    /**
     * Whether data cached under `key` may be served without checking the database
     */
    isFresh(key: string, freshness: Freshness): boolean {
        const maxAge = this.staleness[freshness];
        if (maxAge === Infinity) return true;
        if (maxAge === 0) return false;
        const checkedAt = this.syncedAt.get(key);
        return checkedAt !== undefined && Date.now() - checkedAt <= maxAge;
    }

    markSynced(key: string): void {
        if (!this.enabled || !this.hasStalenessWindow()) return;
        if (this.syncedAt.size >= MAX_TRACKED_AGGREGATES) this.syncedAt.clear();
        this.syncedAt.set(key, Date.now());
    }

    /**
     * Token identifying the current write generation of an aggregate. Pass it to
     * {@link putStream} to skip storing data that a concurrent write has made outdated.
     */
    generation(ref: AggregateRef): string {
        return `${this.epoch}:${this.generations.get(this.streamKey(ref)) ?? 0}`;
    }

    async getStream(ref: AggregateRef): Promise<StreamEntry | null> {
        const value = await this.read<StreamEntry>(this.streamKey(ref));
        return isStreamEntry(value) ? value : null;
    }

    async putStream(ref: AggregateRef, entry: StreamEntry, generation?: string): Promise<void> {
        if (generation !== undefined && generation !== this.generation(ref)) return;
        await this.write(this.streamKey(ref), entry, this.ttl.aggregateEvents);
    }

    /**
     * Merge a freshly loaded part of a stream into the cached entry
     */
    async mergeStream(ref: AggregateRef, incoming: StreamEntry, generation: string, synced: boolean): Promise<void> {
        if (!this.enabled) return;
        const cached = await this.getStream(ref);
        if (synced) this.markSynced(this.streamKey(ref));
        await this.putStream(ref, cached ? mergeEntries(cached, incoming) : incoming, generation);
    }

    /** Cached latest snapshot: `{ snapshot: null }` means the aggregate has none, `null` means unknown */
    async getHead(ref: AggregateRef): Promise<{ snapshot: SnapshotRecord | null } | null> {
        const value = await this.read<{ snapshot: SnapshotRecord | null }>(this.headKey(ref));
        return value && typeof value === 'object' && 'snapshot' in value ? value : null;
    }

    async putHead(ref: AggregateRef, snapshot: SnapshotRecord | null): Promise<void> {
        await this.write(this.headKey(ref), { snapshot }, this.ttl.snapshots);
    }

    /**
     * Store a newly created snapshot as the latest one unless a newer one is cached
     */
    async offerHead(ref: AggregateRef, snapshot: SnapshotRecord): Promise<void> {
        if (!this.enabled) return;
        const cached = await this.getHead(ref);
        if (!cached?.snapshot || cached.snapshot.sequence_number <= snapshot.sequence_number) {
            await this.putHead(ref, snapshot);
        }
    }

    async getSequence(ref: AggregateRef): Promise<number | null> {
        return this.read<number>(this.sequenceKey(ref));
    }

    async putSequence(ref: AggregateRef, sequence: number): Promise<void> {
        await this.write(this.sequenceKey(ref), sequence, this.ttl.sequences);
    }

    async getStats(ref: AggregateRef): Promise<AggregateStatsData | null> {
        return this.read<AggregateStatsData>(this.statsKey(ref));
    }

    async putStats(ref: AggregateRef, stats: AggregateStatsData): Promise<void> {
        await this.write(this.statsKey(ref), stats, this.ttl.aggregateEvents);
    }

    /**
     * Bring cached data up to date after events were stored. In-process caches get the new
     * events appended; shared caches are invalidated where reads would otherwise trust them.
     */
    async afterAppend(saved: EventRecord[]): Promise<void> {
        if (!this.enabled || saved.length === 0) return;

        const byAggregate = new Map<string, { ref: AggregateRef; events: EventRecord[] }>();
        for (const event of saved) {
            const ref = { aggregateId: event.aggregate_id, aggregateType: event.aggregate_type };
            const key = this.streamKey(ref);
            const group = byAggregate.get(key) ?? { ref, events: [] };
            group.events.push(event);
            byAggregate.set(key, group);
        }

        await Promise.all(Array.from(byAggregate.values(), ({ref, events}) =>
            this.applyAppend(ref, events.sort((a, b) => a.sequence_number - b.sequence_number))
        ));
    }

    async dropHead(ref: AggregateRef): Promise<void> {
        await this.remove([this.headKey(ref)]);
    }

    async dropAggregate(ref: AggregateRef): Promise<void> {
        this.bump(ref);
        await this.remove([
            this.streamKey(ref),
            this.headKey(ref),
            this.sequenceKey(ref),
            this.statsKey(ref),
            this.legacyStreamKey(ref),
        ]);
    }

    async clear(): Promise<void> {
        this.epoch++;
        this.generations.clear();
        this.syncedAt.clear();
        await this.service.deletePattern(this.pattern());
    }

    /** Pattern matching every key of this event store */
    pattern(): string {
        return this.buildKey('*');
    }

    private async applyAppend(ref: AggregateRef, events: EventRecord[]): Promise<void> {
        this.bump(ref);
        // Entries some reads serve without checking the database must not fall behind
        const trusted = this.staleness.read > 0 || this.staleness.replay > 0;
        const stale: string[] = [];

        if (this.local) {
            const entry = await this.getStream(ref);
            const last = events[events.length - 1].sequence_number;
            if (entry && events[0].sequence_number === entry.to + 1) {
                for (const event of events) entry.events.push(event);
                entry.to = last;
                await this.putStream(ref, entry);
            } else if (!entry && events[0].sequence_number === 1) {
                // A new aggregate: these events are its complete stream
                await this.putStream(ref, { from: 1, to: last, events });
            } else if (entry && trusted) {
                stale.push(this.streamKey(ref));
            }
        } else if (trusted) {
            // Also drop the key used by versions before 1.2 so instances still running them stay consistent
            stale.push(this.streamKey(ref), this.legacyStreamKey(ref));
        }

        if (this.cachesDerivedValues) stale.push(this.sequenceKey(ref), this.statsKey(ref));
        await this.remove(stale);
    }

    private hasStalenessWindow(): boolean {
        const {read, replay} = this.staleness;
        return (read > 0 && read < Infinity) || (replay > 0 && replay < Infinity);
    }

    private bump(ref: AggregateRef): void {
        const key = this.streamKey(ref);
        if (this.generations.size >= MAX_TRACKED_AGGREGATES && !this.generations.has(key)) {
            this.epoch++;
            this.generations.clear();
        }
        this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    }

    private legacyStreamKey(ref: AggregateRef): string {
        return this.buildKey('agg', escape(ref.aggregateType), escape(ref.aggregateId), 'all');
    }

    private async read<T>(key: string): Promise<T | null> {
        if (!this.enabled) return null;
        try {
            return await this.service.get<T>(key);
        } catch (err) {
            console.error('Cache read error:', err);
            return null;
        }
    }

    private async write(key: string, value: unknown, ttl: number): Promise<void> {
        if (!this.enabled || !(ttl > 0)) return;
        try {
            await this.service.set(key, value, ttl);
        } catch (err) {
            console.error('Cache write error:', err);
        }
    }

    private async remove(keys: string[]): Promise<void> {
        if (!this.enabled || keys.length === 0) return;
        try {
            if (this.service.deleteMany) {
                await this.service.deleteMany(keys);
            } else {
                await Promise.all(keys.map(key => this.service.delete(key)));
            }
        } catch (err) {
            console.error('Cache delete error:', err);
        }
    }
}

/**
 * Events of an entry within [from, to]
 */
export function sliceStream(entry: StreamEntry, from: number, to?: number): EventRecord[] {
    const start = lowerBound(entry.events, from);
    const end = to === undefined ? entry.events.length : lowerBound(entry.events, to + 1);
    return entry.events.slice(start, end);
}

/**
 * Union of two entries; if they are not contiguous, the one reaching further wins
 */
export function mergeEntries(a: StreamEntry, b: StreamEntry): StreamEntry {
    const [first, second] = a.from <= b.from ? [a, b] : [b, a];
    if (second.from > first.to + 1) return second.to >= first.to ? second : first;

    const events = first.events.filter(event => event.sequence_number < second.from);
    for (const event of second.events) events.push(event);
    if (first.to > second.to) {
        for (const event of first.events) {
            if (event.sequence_number > second.to) events.push(event);
        }
    }
    return { from: first.from, to: Math.max(first.to, second.to), events };
}

/**
 * Highest sequence number in a list of events ordered ascending, or `fallback` if empty
 */
export function lastSequence(events: EventRecord[], fallback: number): number {
    return events.length > 0 ? events[events.length - 1].sequence_number : fallback;
}

function lowerBound(events: EventRecord[], sequence: number): number {
    let low = 0;
    let high = events.length;
    while (low < high) {
        const mid = (low + high) >>> 1;
        if (events[mid].sequence_number < sequence) low = mid + 1;
        else high = mid;
    }
    return low;
}

function isStreamEntry(value: unknown): value is StreamEntry {
    const entry = value as StreamEntry | null;
    return !!entry && typeof entry === 'object' && Array.isArray(entry.events)
        && typeof entry.from === 'number' && typeof entry.to === 'number';
}

// Keep key parts unambiguous when ids or types contain ':'
function escape(part: string): string {
    return part.replace(/%/g, '%25').replace(/:/g, '%3A');
}
