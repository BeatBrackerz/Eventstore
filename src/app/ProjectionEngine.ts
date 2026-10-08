import {
    comparePositions,
    type EventRecord,
    EventStoreError,
    keyId,
    latestPosition,
    normalizeKey,
    type Position,
    positionOf,
    type ProjectionContext,
    type ReadModelChange,
    type ReadModelCollection,
    type ReadModelKey,
    type ReadModelPage,
    type ReadModelQuery,
    type ReadModelRow,
    START_POSITION,
    applyChange,
} from "../domain/index.js";
import type {IEventPublisher, IEventRepository, IReadModelStore, ReadAllResult} from "../ports/index.js";

export type ProjectionHandler = (event: EventRecord, context: ProjectionContext) => void | Promise<void>;

/**
 * A projection turns events into read models – tables or search indices that queries read
 * directly instead of replaying events.
 */
export interface ProjectionDefinition {
    /** Unique name; the checkpoint is stored under it */
    name: string;
    /** Increase it after changing handlers or collections: the read models are rebuilt from the first event (default: 1) */
    version?: number;
    /** Collections the projection writes to. They belong to it: a rebuild empties them. */
    collections: ReadonlyArray<string | ReadModelCollection>;
    /** Handlers by event type. Only events of these types are read. */
    handlers: Readonly<Record<string, ProjectionHandler>>;
    /** Only events of these aggregate types */
    aggregateTypes?: readonly string[];
    /**
     * `'inline'` (default): appends through this EventStore return after the projection has processed
     * the new events, so the writer reads its own writes. `'async'`: processed by `start()`, `catchUp()`
     * and reads with `consistentWith` only, which keeps appends fast.
     */
    mode?: 'inline' | 'async';
    /** Store of the collections (default: the EventStore's read model store) */
    store?: IReadModelStore;
}

export interface ProjectionOptions {
    batchSize?: number; // Events per batch; each batch is stored in one commit (default: 500)
    waitTimeoutMs?: number; // How long inline projections and `consistentWith` reads wait (default: 5000)
    /** Errors of inline and background processing (default: console.error). Called once per new error. */
    onError?: (error: ProjectionError) => void;
}

export interface StartOptions {
    intervalMs?: number; // Poll interval (default: 1000)
    realtime?: boolean; // Also wake up on new events via the event publisher (Supabase Realtime, needs enablePublisher)
}

export interface ProjectionStatus {
    name: string;
    version: number;
    mode: 'inline' | 'async';
    position: Position | null; // Checkpoint as last seen by this process (null before the first run)
    lastError: ProjectionError | null;
}

/**
 * Error of a projection. `event` is set when a handler failed on it.
 */
export class ProjectionError extends EventStoreError {
    constructor(message: string, readonly projection: string, cause?: unknown, readonly event?: EventRecord) {
        super(message, cause);
        this.name = 'ProjectionError';
    }
}

/** Where a collection is stored and which projection writes it */
export interface CollectionTarget {
    store: IReadModelStore;
    collection: ReadModelCollection;
    projection?: string;
}

interface ProjectionState {
    name: string;
    version: number;
    mode: 'inline' | 'async';
    definition: ProjectionDefinition;
    store: IReadModelStore;
    collections: Map<string, ReadModelCollection>;
    eventTypes: string[];
    position: Position | null;
    lastError: ProjectionError | null;
    reportedError?: string;
    lock: Promise<void>;
    pendingPass?: Promise<void>;
}

interface Loop {
    intervalMs: number;
    timer?: ReturnType<typeof setTimeout>;
    running?: Promise<void>;
    again: boolean;
    unsubscribe?: () => void;
}

/**
 * Runs projections: reads events in commit order, hands them to the handlers in batches and
 * stores each batch's read model changes together with the projection's checkpoint.
 *
 * Every store commit is conditional on the checkpoint it started from, so several processes can
 * run the same projection: a batch that lost the race is discarded and processing continues from
 * the stored checkpoint.
 */
export class ProjectionEngine {
    private readonly states = new Map<string, ProjectionState>();
    private readonly owners = new Map<string, ProjectionState>();
    private readonly batchSize: number;
    private readonly waitTimeoutMs: number;
    private readonly onError: (error: ProjectionError) => void;
    private loop?: Loop;

    constructor(
        private readonly repository: IEventRepository,
        private readonly defaultStore?: IReadModelStore,
        definitions: readonly ProjectionDefinition[] = [],
        options: ProjectionOptions = {},
        private readonly publisher?: IEventPublisher
    ) {
        this.batchSize = options.batchSize ?? 500;
        this.waitTimeoutMs = options.waitTimeoutMs ?? 5000;
        this.onError = options.onError ?? (error => console.error(error));

        for (const definition of definitions) this.register(definition);
    }

    /**
     * Register a projection
     */
    register(definition: ProjectionDefinition): void {
        const { name } = definition;
        const version = definition.version ?? 1;

        if (this.states.has(name)) throw new EventStoreError(`Projection ${name} is registered twice`);
        if (!Number.isInteger(version) || version < 1) throw new EventStoreError(`Projection ${name}: version must be a positive integer`);

        const store = definition.store ?? this.defaultStore;
        if (!store) throw new EventStoreError(`Projection ${name} has no store and the EventStore has no read model store`);

        const eventTypes = Object.keys(definition.handlers);
        if (eventTypes.length === 0) throw new EventStoreError(`Projection ${name} has no handlers`);

        const collections = new Map<string, ReadModelCollection>();
        for (const entry of definition.collections) {
            const collection = typeof entry === 'string' ? { name: entry } : entry;
            const owner = this.owners.get(collection.name);
            if (owner || collections.has(collection.name)) {
                throw new EventStoreError(`Collection ${collection.name} is written by projection ${owner?.name ?? name} already`);
            }
            collections.set(collection.name, collection);
        }

        const state: ProjectionState = {
            name,
            version,
            mode: definition.mode ?? 'inline',
            definition,
            store,
            collections,
            eventTypes,
            position: null,
            lastError: null,
            lock: Promise.resolve(),
        };

        this.states.set(name, state);
        for (const collection of collections.keys()) this.owners.set(collection, state);
    }

    /**
     * Process all events available now. Without names, all projections.
     */
    async catchUp(names?: readonly string[]): Promise<void> {
        await Promise.all(this.select(names).map(state => this.pass(state)));
    }

    /**
     * Empty the projection's collections and process all events again
     */
    async rebuild(name: string): Promise<void> {
        const state = this.state(name);

        await this.exclusive(state, async () => {
            const collections = Array.from(state.collections.values());
            if (!(await state.store.reset(state.name, state.version, collections, true))) throw this.outdated(state);
            state.position = START_POSITION;
        });

        await this.pass(state);
    }

    /**
     * Wait until the projections (default: all) have processed everything up to `target`,
     * processing events in this process meanwhile
     */
    async waitFor(target: Position, names?: readonly string[], timeoutMs: number = this.waitTimeoutMs): Promise<void> {
        const deadline = Date.now() + timeoutMs;

        await Promise.all(this.select(names).map(async state => {
            const timedOut = () => new ProjectionError(
                `Projection ${state.name} did not reach position ${target.transactionId}/${target.globalPosition} within ${timeoutMs} ms`,
                state.name
            );

            // Events of transactions that started earlier but are still running hold back newer ones
            for (let delay = 5; !reached(state, target); delay = Math.min(delay * 2, 100)) {
                // A long catch-up (or a handler appending to its own projection) continues in the background
                const pass = this.pass(state);
                if (!(await settlesWithin(pass, deadline - Date.now()))) {
                    pass.then(() => this.recovered(state), err => this.report(state, err));
                    throw timedOut();
                }
                await pass;
                if (reached(state, target)) return;
                if (Date.now() >= deadline) throw timedOut();
                await sleep(Math.min(delay, Math.max(0, deadline - Date.now())));
            }
        }));
    }

    /**
     * Called by the EventStore after events were appended: waits for the inline projections that
     * handle them. Errors are reported to `onError`, not thrown – the events are stored either way.
     */
    async afterAppend(events: readonly EventRecord[]): Promise<void> {
        const waits: Promise<void>[] = [];

        for (const state of this.states.values()) {
            if (state.mode !== 'inline') continue;

            const relevant = events.filter(event => handles(state, event));
            if (relevant.length === 0) continue;

            const target = latestPosition(relevant);
            const wait = target ? this.waitFor(target, [state.name]) : this.pass(state);
            waits.push(wait.then(() => this.recovered(state), err => this.report(state, err)));
        }

        await Promise.all(waits);
    }

    /**
     * Process events in the background: every `intervalMs` and, with `realtime`, as soon as
     * new events are published
     */
    start(options: StartOptions = {}): void {
        if (this.loop) return;
        if (options.realtime && !this.publisher) {
            throw new EventStoreError('Projections: realtime needs an event publisher (enablePublisher: true)');
        }

        const loop: Loop = { intervalMs: options.intervalMs ?? 1000, again: false };
        this.loop = loop;
        if (options.realtime) loop.unsubscribe = this.publisher!.subscribe(() => this.wake());
        this.wake();
    }

    /**
     * Stop background processing and wait for the current run to finish
     */
    async stop(): Promise<void> {
        const loop = this.loop;
        if (!loop) return;

        this.loop = undefined;
        clearTimeout(loop.timer);
        loop.unsubscribe?.();
        await loop.running;
    }

    /**
     * State of the projections as seen by this process. `es_projection_status` in the database
     * shows the stored checkpoints and how many events each projection has still to process.
     */
    status(): ProjectionStatus[] {
        return Array.from(this.states.values(), state => ({
            name: state.name,
            version: state.version,
            mode: state.mode,
            position: state.position,
            lastError: state.lastError,
        }));
    }

    /**
     * Store and projection of a collection. Collections no projection writes are looked up in the
     * default read model store.
     */
    collection(name: string): CollectionTarget {
        const owner = this.owners.get(name);
        if (owner) return { store: owner.store, collection: owner.collections.get(name)!, projection: owner.name };
        if (!this.defaultStore) throw new EventStoreError(`Collection ${name} is not written by any projection and there is no read model store`);
        return { store: this.defaultStore, collection: { name } };
    }

    // ============================================================================
    // PRIVATE HELPERS
    // ============================================================================

    /**
     * Run a pass after the current one. Callers arriving before it starts share it, so a burst of
     * appends does not queue one pass per append.
     */
    private pass(state: ProjectionState): Promise<void> {
        return state.pendingPass ??= this.exclusive(state, () => {
            state.pendingPass = undefined;
            return this.process(state);
        });
    }

    private exclusive(state: ProjectionState, task: () => Promise<void>): Promise<void> {
        const result = state.lock.then(task);
        state.lock = result.catch(() => undefined);
        return result;
    }

    private async process(state: ProjectionState): Promise<void> {
        try {
            let checkpoint = state.position ?? await this.loadCheckpoint(state);

            for (;;) {
                const batch = await this.read(state, checkpoint);
                if (batch.events.length === 0 && comparePositions(batch.next, checkpoint) <= 0) break;

                const context = new BatchContext(state);
                for (const event of batch.events) {
                    if (!handles(state, event)) continue;
                    context.begin(positionOf(event) ?? batch.next);
                    try {
                        await state.definition.handlers[event.type](event, context);
                    } catch (err) {
                        throw new ProjectionError(
                            `Projection ${state.name} failed on event ${event.id} (${event.type}): ${messageOf(err)}`,
                            state.name, err, event
                        );
                    }
                }

                const committed = await state.store.commit({
                    projection: state.name,
                    version: state.version,
                    expected: checkpoint,
                    next: batch.next,
                    changes: context.changes,
                });

                if (!committed) {
                    // Another process stored this batch (or rebuilt the projection) first
                    checkpoint = await this.loadCheckpoint(state);
                    continue;
                }

                checkpoint = batch.next;
                state.position = checkpoint;
                if (batch.done) break;
            }

            state.lastError = null;
        } catch (err) {
            const error = err instanceof ProjectionError
                ? err
                : new ProjectionError(`Projection ${state.name} failed: ${messageOf(err)}`, state.name, err);
            state.lastError = error;
            throw error;
        }
    }

    /**
     * Stored checkpoint; a projection that is new or has a higher version than stored is reset first.
     * If another process initialized it in the meantime, the first commit from the start conflicts
     * and processing continues from that process' checkpoint.
     */
    private async loadCheckpoint(state: ProjectionState): Promise<Position> {
        const stored = await state.store.getCheckpoint(state.name);

        if (stored && stored.version === state.version) {
            state.position = stored.position;
            return stored.position;
        }
        if (stored && stored.version > state.version) throw this.outdated(state, stored.version);

        if (!(await state.store.reset(state.name, state.version, Array.from(state.collections.values())))) {
            throw this.outdated(state);
        }
        state.position = START_POSITION;
        return START_POSITION;
    }

    private async read(state: ProjectionState, after: Position): Promise<ReadAllResult> {
        const result = await this.repository.readAll?.({
            after,
            limit: this.batchSize,
            eventTypes: state.eventTypes,
            aggregateTypes: state.definition.aggregateTypes,
        });
        if (!result) {
            throw new ProjectionError('Projections need the database function es_read_all: run sql/eventstore.sql', state.name);
        }
        return result;
    }

    private outdated(state: ProjectionState, storedVersion?: number): ProjectionError {
        return new ProjectionError(
            `Projection ${state.name} is stored with ${storedVersion ? `version ${storedVersion}` : 'a newer version'}; ` +
            `this process runs version ${state.version} and leaves it alone`,
            state.name
        );
    }

    private wake(): void {
        const loop = this.loop;
        if (!loop) return;
        if (loop.running) {
            loop.again = true;
            return;
        }

        clearTimeout(loop.timer);
        loop.running = this.tick().finally(() => {
            loop.running = undefined;
            if (this.loop !== loop) return;
            if (loop.again) {
                loop.again = false;
                this.wake();
            } else {
                loop.timer = setTimeout(() => this.wake(), loop.intervalMs);
            }
        });
    }

    private async tick(): Promise<void> {
        await Promise.all(Array.from(this.states.values(), state =>
            this.pass(state).then(() => this.recovered(state), err => this.report(state, err))
        ));
    }

    private report(state: ProjectionState, err: unknown): void {
        const error = err instanceof ProjectionError ? err : new ProjectionError(messageOf(err), state.name, err);
        // Retries fail the same way until the cause is fixed: report each error once
        if (state.reportedError === error.message) return;
        state.reportedError = error.message;
        try {
            this.onError(error);
        } catch {
            // An error handler must not break processing
        }
    }

    private recovered(state: ProjectionState): void {
        state.reportedError = undefined;
    }

    private state(name: string): ProjectionState {
        const state = this.states.get(name);
        if (!state) throw new EventStoreError(`Unknown projection ${name}`);
        return state;
    }

    private select(names?: readonly string[]): ProjectionState[] {
        return names ? names.map(name => this.state(name)) : Array.from(this.states.values());
    }
}

/**
 * Store-independent queries of read models
 */
export interface ConsistencyOptions {
    /**
     * Wait until the projection writing the collection has processed these events (e.g. the result
     * of `appendEvents`) or this position before reading – read-your-writes for async projections
     */
    consistentWith?: EventRecord | readonly EventRecord[] | Position;
    timeoutMs?: number; // Default: the engine's waitTimeoutMs
}

/**
 * Reads read models: by key or with a query, from whichever store holds the collection
 */
export class ReadModels {
    constructor(private readonly engine: ProjectionEngine) {}

    /**
     * Row of a collection by key
     */
    async get<T = ReadModelRow>(collection: string, key: ReadModelKey, options: ConsistencyOptions = {}): Promise<T | null> {
        const target = await this.resolve(collection, options);
        return target.store.get<T>(target.collection, normalizeKey(target.collection, key));
    }

    /**
     * Rows of a collection matching a query
     */
    async find<T = ReadModelRow>(collection: string, query: ReadModelQuery & ConsistencyOptions = {}): Promise<ReadModelPage<T>> {
        const { consistentWith, timeoutMs, ...rest } = query;
        const target = await this.resolve(collection, { consistentWith, timeoutMs });
        return target.store.find<T>(target.collection, rest);
    }

    /**
     * Wait until the projections writing the given collections (default: all projections) have
     * processed the events
     */
    async waitFor(
        events: EventRecord | readonly EventRecord[] | Position,
        options: { collections?: readonly string[]; timeoutMs?: number } = {}
    ): Promise<void> {
        const names = options.collections?.map(name => this.engine.collection(name).projection)
            .filter((name): name is string => name !== undefined);
        await this.engine.waitFor(toPosition(events), names, options.timeoutMs);
    }

    private async resolve(collection: string, options: ConsistencyOptions): Promise<CollectionTarget> {
        const target = this.engine.collection(collection);
        if (options.consistentWith) {
            if (!target.projection) throw new EventStoreError(`consistentWith: collection ${collection} is not written by a projection`);
            await this.engine.waitFor(toPosition(options.consistentWith), [target.projection], options.timeoutMs);
        }
        return target;
    }
}

/**
 * Collects the changes of one batch. `get` sees the stored row plus the changes made so far.
 */
class BatchContext implements ProjectionContext {
    readonly changes: ReadModelChange[] = [];
    private position: Position = START_POSITION;
    private ordinal = 0;
    private readonly loaded = new Map<string, Promise<ReadModelRow | null>>();

    constructor(private readonly state: ProjectionState) {}

    /** Start collecting the changes of the next event */
    begin(position: Position): void {
        this.position = position;
        this.ordinal = 0;
    }

    upsert(collection: string, row: ReadModelRow): void {
        const key = normalizeKey(this.collection(collection), row);
        // Undefined values are not given (as in JSON), so they leave the stored value unchanged
        const given = Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined));
        this.push({ op: 'upsert', collection, key, row: structuredClone(given) });
    }

    increment(collection: string, key: ReadModelKey, values: Record<string, number>): void {
        const normalized = normalizeKey(this.collection(collection), key);
        for (const [column, value] of Object.entries(values)) {
            if (column in normalized) throw new EventStoreError(`increment: ${column} is a key column of ${collection}`);
            if (typeof value !== 'number' || !Number.isFinite(value)) throw new EventStoreError(`increment: ${column} must be a finite number`);
        }
        this.push({ op: 'increment', collection, key: normalized, values: { ...values } });
    }

    delete(collection: string, key: ReadModelKey): void {
        const normalized = normalizeKey(this.collection(collection), key);
        this.push({ op: 'delete', collection, key: normalized });
    }

    async get<T extends ReadModelRow = ReadModelRow>(collection: string, key: ReadModelKey): Promise<T | null> {
        const spec = this.collection(collection);
        const normalized = normalizeKey(spec, key);
        const id = `${collection}\u0000${keyId(normalized)}`;

        let loaded = this.loaded.get(id);
        if (!loaded) {
            loaded = this.state.store.get<ReadModelRow>(spec, normalized);
            this.loaded.set(id, loaded);
        }

        let row = structuredClone(await loaded);
        for (const change of this.changes) {
            if (change.collection === collection && keyId(change.key) === keyId(normalized)) {
                row = applyChange(row, change);
            }
        }
        return row as T | null;
    }

    private push(change: Unpositioned<ReadModelChange>): void {
        this.changes.push({ ...change, position: this.position, ordinal: this.ordinal++ } as ReadModelChange);
    }

    private collection(name: string): ReadModelCollection {
        const collection = this.state.collections.get(name);
        if (!collection) throw new EventStoreError(`Projection ${this.state.name} does not declare collection ${name}`);
        return collection;
    }
}

type Unpositioned<T> = T extends unknown ? Omit<T, 'position' | 'ordinal'> : never;

function handles(state: ProjectionState, event: EventRecord): boolean {
    const aggregateTypes = state.definition.aggregateTypes;
    return Object.hasOwn(state.definition.handlers, event.type)
        && (!aggregateTypes || aggregateTypes.includes(event.aggregate_type));
}

function reached(state: ProjectionState, target: Position): boolean {
    return state.position !== null && comparePositions(state.position, target) >= 0;
}

function toPosition(value: EventRecord | readonly EventRecord[] | Position): Position {
    if ('transactionId' in value) return value;
    const position = latestPosition(Array.isArray(value) ? value : [value as EventRecord]);
    if (!position) throw new EventStoreError('The events have no position: run sql/eventstore.sql');
    return position;
}

function messageOf(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Whether the promise settles (fulfilled or rejected) within `ms`
 */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<false>(resolve => {
        timer = setTimeout(() => resolve(false), Math.max(0, ms));
    });
    try {
        return await Promise.race([promise.then(() => true, () => true), timeout]);
    } finally {
        clearTimeout(timer);
    }
}
