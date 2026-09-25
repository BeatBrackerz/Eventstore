import {randomUUID} from 'node:crypto';
import {Redis} from 'ioredis';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {type CreateEventInput, EventStore, RedisCacheService} from '../../src/index.js';
import {FakeDatabase, FakeEventRepository, FakeSequenceRepository, FakeSnapshotRepository} from '../support/fakes.js';
import {redisUrl as configuredRedisUrl} from '../support/postgrest.js';

const redisUrl = configuredRedisUrl();

describe.skipIf(!redisUrl)('RedisCacheService with ioredis', () => {
    let redis: Redis;
    const prefix = `es-test-${randomUUID()}:`;

    beforeAll(() => {
        redis = new Redis(redisUrl!);
    });

    afterAll(async () => {
        await new RedisCacheService(redis).deletePattern(`${prefix}*`);
        redis.disconnect();
    });

    it('stores values with expiry and deletes them by key and pattern using SCAN', async () => {
        const cache = new RedisCacheService(redis, { keyPrefix: prefix });

        await cache.set(`${prefix}a`, { list: [1] }, 60);
        expect(await cache.get(`${prefix}a`)).toEqual({ list: [1] });
        expect(await redis.ttl(`${prefix}a`)).toBeGreaterThan(55);

        await cache.setMultiple(Array.from({ length: 1200 }, (_, i) => ({ key: `${prefix}bulk:${i}`, value: i, ttl: 60 })));
        expect(await cache.countKeys(`${prefix}bulk:*`)).toBe(1200);
        expect((await cache.getMultiple([`${prefix}bulk:1`, `${prefix}bulk:2`, `${prefix}missing`])).size).toBe(2);

        await cache.deleteMany([`${prefix}bulk:1`, `${prefix}bulk:2`]);
        await cache.deletePattern(`${prefix}bulk:*`);
        expect(await cache.countKeys(`${prefix}bulk:*`)).toBe(0);
        expect(await cache.get(`${prefix}a`)).toEqual({ list: [1] });

        await cache.delete(`${prefix}a`);
        expect(await cache.get(`${prefix}a`)).toBeNull();
    });

    it('keeps several event store instances consistent through the shared cache', async () => {
        const db = new FakeDatabase();
        const build = () => new EventStore({
            eventRepository: new FakeEventRepository(db),
            sequenceRepository: new FakeSequenceRepository(db),
            snapshotRepository: new FakeSnapshotRepository(db),
            cacheService: new RedisCacheService(redis, { keyPrefix: prefix }),
        });
        const [a, b] = [build(), build()];
        const input = (type: string): CreateEventInput => ({ type, aggregate_id: 'order-1', aggregate_type: 'order', created_by: 'u' });

        await a.appendEvents([input('Created'), input('Paid')]);
        await a.getAggregateEvents('order-1', 'order');
        db.resetCalls();
        expect((await b.getAggregateEvents('order-1', 'order')).map(e => e.type)).toEqual(['Created', 'Paid']);
        expect(db.calls).toEqual([]);

        await b.appendEvent(input('Shipped'));
        expect((await a.getAggregateEvents('order-1', 'order')).map(e => e.type)).toEqual(['Created', 'Paid', 'Shipped']);

        const stats = await a.getCacheStats();
        expect(stats).toMatchObject({ enabled: true, type: 'RedisCacheService' });
        expect(stats.info?.keys).toBeGreaterThan(0);
        expect(stats.info?.memory).not.toBe('unknown');

        await a.clearCache();
        expect(await new RedisCacheService(redis).countKeys(`${prefix}*`)).toBe(0);
    });
});
