interface Waiter<T> {
    resolve(value: T): void;
    reject(reason: unknown): void;
}

/**
 * Deduplicates concurrent calls with the same key: the first caller runs the work, callers arriving
 * while it is in flight wait for its result. Every waiter receives its own copy, so callers can
 * mutate what they get without affecting each other.
 */
export class SingleFlight {
    private readonly flights = new Map<string, Array<Waiter<any>>>();

    async run<T>(key: string, work: () => Promise<T>, copy: (value: T) => T = cloneJson): Promise<T> {
        const inFlight = this.flights.get(key);
        if (inFlight) {
            return new Promise<T>((resolve, reject) => inFlight.push({resolve, reject}));
        }

        const waiters: Array<Waiter<T>> = [];
        this.flights.set(key, waiters);
        try {
            const result = await work();
            // Copy before the first caller gets the original and can mutate it
            for (const waiter of waiters) {
                try {
                    waiter.resolve(copy(result));
                } catch (err) {
                    waiter.reject(err);
                }
            }
            return result;
        } catch (err) {
            for (const waiter of waiters) waiter.reject(err);
            throw err;
        } finally {
            this.flights.delete(key);
        }
    }
}

/**
 * Deep copy of JSON-compatible data (everything the event store reads from the database or cache)
 */
export function cloneJson<T>(value: T): T {
    return value === undefined ? value : JSON.parse(JSON.stringify(value));
}
