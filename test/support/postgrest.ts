import {execFileSync} from 'node:child_process';
import {createHmac} from 'node:crypto';
import http from 'node:http';
import type {AddressInfo} from 'node:net';
import {createClient, type SupabaseClient} from '@supabase/supabase-js';

/**
 * Integration test environment, see CONTRIBUTING.md. Tests are skipped when it is not
 * configured, unless EVENTSTORE_IT_REQUIRED is set (as in CI).
 */
export function integrationEnv() {
    const url = process.env.EVENTSTORE_IT_POSTGREST_URL;
    const legacyUrl = process.env.EVENTSTORE_IT_POSTGREST_LEGACY_URL;
    const partitionedUrl = process.env.EVENTSTORE_IT_POSTGREST_PARTITIONED_URL;
    const jwtSecret = process.env.EVENTSTORE_IT_JWT_SECRET;
    return url && legacyUrl && partitionedUrl && jwtSecret
        ? { url, legacyUrl, partitionedUrl, jwtSecret }
        : requireEnv('EVENTSTORE_IT_POSTGREST_*');
}

/**
 * Direct database access with psql (connection via the usual PG* environment variables), for
 * tests that need their own transactions or databases
 */
export function postgresEnv(): { psql: (database: string, sql: string) => string } | undefined {
    if (!process.env.PGHOST) return requireEnv('PGHOST (psql access)');
    return {
        psql: (database, sql) => execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-qAt', '-d', database, '-c', sql], { encoding: 'utf8' }).trim(),
    };
}

export function redisUrl(): string | undefined {
    return process.env.EVENTSTORE_IT_REDIS_URL ?? requireEnv('EVENTSTORE_IT_REDIS_URL');
}

function requireEnv(name: string): undefined {
    if (process.env.EVENTSTORE_IT_REQUIRED) {
        throw new Error(`Integration tests require ${name} (EVENTSTORE_IT_REQUIRED is set)`);
    }
    return undefined;
}

/**
 * Serves PostgREST under /rest/v1 like Supabase does, records requests and can add latency
 */
export class RestProxy {
    requests: string[] = [];
    responseBytes = 0;
    latencyMs = 0;
    private readonly target: string;
    private server?: http.Server;

    constructor(target: string) {
        this.target = target;
    }

    async start(): Promise<string> {
        this.server = http.createServer((req, res) => {
            this.forward(req, res).catch(err => {
                res.statusCode = 502;
                res.end(String(err));
            });
        });
        await new Promise<void>(resolve => this.server!.listen(0, '127.0.0.1', resolve));
        return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    }

    async stop(): Promise<void> {
        await new Promise<void>(resolve => this.server?.close(() => resolve()) ?? resolve());
    }

    reset(): string[] {
        const requests = this.requests;
        this.requests = [];
        this.responseBytes = 0;
        return requests;
    }

    private async forward(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const url = new URL(req.url ?? '/', 'http://proxy');
        const path = url.pathname.replace(/^\/rest\/v1/, '');
        this.requests.push(`${req.method} ${decodeURIComponent(path)}`);

        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);

        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(req.headers)) {
            if (typeof value === 'string' && !['host', 'connection', 'content-length', 'accept-encoding'].includes(name)) {
                headers[name] = value;
            }
        }

        if (this.latencyMs > 0) await new Promise(resolve => setTimeout(resolve, this.latencyMs));

        const upstream = await fetch(this.target + path + url.search, {
            method: req.method,
            headers,
            body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
        });
        const body = Buffer.from(await upstream.arrayBuffer());
        this.responseBytes += body.length;

        upstream.headers.forEach((value, name) => {
            if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(name)) {
                res.setHeader(name, value);
            }
        });
        res.statusCode = upstream.status;
        res.end(body);
    }
}

export function serviceRoleClient(url: string, jwtSecret: string, role = 'service_role'): SupabaseClient {
    return createClient(url, signJwt({ role }, jwtSecret), {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
}

function signJwt(payload: object, secret: string): string {
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}`;
    return `${unsigned}.${createHmac('sha256', secret).update(unsigned).digest('base64url')}`;
}
