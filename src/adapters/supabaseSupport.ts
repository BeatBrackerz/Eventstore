import type {SupabaseClient} from "@supabase/supabase-js";
import {EventStoreError} from "../domain/index.js";

/**
 * Options shared by the Supabase adapters
 */
export interface SupabaseAdapterOptions {
    /**
     * Use the database functions installed by `sql/eventstore.sql`.
     * `'auto'` (default) uses them when present and falls back otherwise, `true` requires them,
     * `false` never calls them.
     */
    rpc?: boolean | 'auto';
    /** Rows per request when paginating. Must not exceed PostgREST's max-rows (Supabase default: 1000). */
    pageSize?: number;
}

export type AnySupabaseClient = SupabaseClient<any, any, any>;

export const DEFAULT_PAGE_SIZE = 1000;

// A function that was missing is looked up again after this delay (e.g. after running the migration)
const MISSING_FUNCTION_RETRY_MS = 5 * 60 * 1000;

/**
 * Calls database functions and remembers which ones are not installed
 */
export class RpcSupport {
    private readonly missingSince = new Map<string, number>();

    constructor(
        private readonly client: AnySupabaseClient,
        private readonly mode: boolean | 'auto' = 'auto'
    ) {}

    /**
     * Call a database function. Resolves to `undefined` if RPC is disabled or the function is not installed.
     */
    async call<T>(fn: string, args: Record<string, unknown>): Promise<T | undefined> {
        if (this.mode === false) return undefined;

        const missingSince = this.missingSince.get(fn);
        if (missingSince !== undefined && Date.now() - missingSince < MISSING_FUNCTION_RETRY_MS) return undefined;

        const {data, error} = await this.client.rpc(fn, args);

        if (error) {
            if (isMissingFunction(error)) {
                if (this.mode === 'auto') {
                    this.missingSince.set(fn, Date.now());
                    return undefined;
                }
                throw new EventStoreError(`Database function ${fn} is not installed. Run sql/eventstore.sql from @beatbrackerz/eventstore.`, error);
            }
            throw new EventStoreError(`Database function ${fn} failed: ${error.message}`, error);
        }

        this.missingSince.delete(fn);
        return data as T;
    }
}

function isMissingFunction(error: { code?: string }): boolean {
    // PGRST202: not in PostgREST's schema cache, 42883: undefined_function
    return error.code === 'PGRST202' || error.code === '42883';
}
