import {Client as ElasticsearchClient} from '@elastic/elasticsearch';
import {createClient} from '@supabase/supabase-js';
import {Cluster, Redis} from 'ioredis';
import {describe, expect, it} from 'vitest';
import {
    createEventStore,
    type ElasticsearchClientLike,
    ElasticsearchReadModelStore,
    RedisCacheService,
    type RedisClientLike,
} from '../../src/index.js';

// Checked by `npm run typecheck`: ioredis and Elasticsearch clients and generated Supabase types must be accepted without casts
interface Database {
    public: {
        Tables: {
            events: {
                Row: { id: string; type: string; aggregate_id: string };
                Insert: { type: string; aggregate_id: string };
                Update: { type?: string };
                Relationships: [];
            };
        };
        Views: Record<string, never>;
        Functions: Record<string, never>;
        Enums: Record<string, never>;
        CompositeTypes: Record<string, never>;
    };
}

describe('type compatibility', () => {
    it('accepts ioredis clients and typed Supabase clients', () => {
        const redis = new Redis({ lazyConnect: true });
        const cluster = new Cluster([{ host: '127.0.0.1', port: 1 }], { lazyConnect: true });
        const supabase = createClient<Database>('http://127.0.0.1:1', 'key', {
            auth: { persistSession: false, autoRefreshToken: false },
        });

        const clients: RedisClientLike[] = [redis, cluster];
        const store = createEventStore({ supabase, redis: cluster });
        const client: Redis = new RedisCacheService(redis).getRedisClient();

        expect(clients).toHaveLength(2);
        expect(store).toBeDefined();
        expect(client).toBe(redis);

        redis.disconnect();
        cluster.disconnect();
    });

    it('accepts the official Elasticsearch client', async () => {
        const elasticsearch = new ElasticsearchClient({ node: 'http://127.0.0.1:1' });
        const client: ElasticsearchClientLike = elasticsearch;
        const store = createEventStore({
            supabase: createClient('http://127.0.0.1:1', 'key', { auth: { persistSession: false, autoRefreshToken: false } }),
            readModelStore: new ElasticsearchReadModelStore(elasticsearch),
        });

        expect(client).toBe(elasticsearch);
        expect(store.readModels).toBeDefined();
        await elasticsearch.close();
    });
});
