import {describe, expect, it} from 'vitest';
import {type EventRecord, SupabaseEventPublisher} from '../../src/index.js';

// Mimics supabase-js: channel() returns the existing channel for a known topic,
// and adding postgres_changes listeners after subscribe() throws
class FakeRealtimeClient {
    channels = new Map<string, FakeChannel>();
    removed: string[] = [];

    channel(topic: string) {
        const existing = this.channels.get(topic);
        if (existing) return existing;
        const channel = new FakeChannel(topic);
        this.channels.set(topic, channel);
        return channel;
    }

    async removeChannel(channel: FakeChannel) {
        this.channels.delete(channel.topic);
        this.removed.push(channel.topic);
        return 'ok';
    }
}

class FakeChannel {
    subscribed = false;
    filter?: string;
    listener?: (payload: { new: EventRecord }) => void;

    constructor(readonly topic: string) {}

    on(_type: string, config: { filter?: string }, listener: (payload: { new: EventRecord }) => void) {
        if (this.subscribed) throw new Error(`cannot add postgres_changes callbacks for ${this.topic} after subscribe()`);
        this.filter = config.filter;
        this.listener = listener;
        return this;
    }

    subscribe() {
        this.subscribed = true;
        return this;
    }
}

describe('SupabaseEventPublisher', () => {
    it('supports several independent subscriptions', () => {
        const client = new FakeRealtimeClient();
        const publisher = new SupabaseEventPublisher(client as never);
        const received: string[] = [];

        const unsubscribeAll = publisher.subscribe(e => received.push(`all:${e.type}`));
        const unsubscribeOrders = publisher.subscribe(e => received.push(`orders:${e.type}`), { aggregate_type: 'order' });

        expect(client.channels.size).toBe(2);
        for (const channel of client.channels.values()) channel.listener!({ new: { type: 'Created' } as EventRecord });
        expect(received).toEqual(['all:Created', 'orders:Created']);

        unsubscribeOrders();
        expect(client.channels.size).toBe(1);
        unsubscribeAll();
        expect(client.removed).toHaveLength(2);
    });

    it('combines filters and quotes reserved characters', () => {
        const client = new FakeRealtimeClient();
        new SupabaseEventPublisher(client as never).subscribe(() => {}, {
            aggregate_type: 'billing,invoice',
            type: 'Paid',
        });

        expect([...client.channels.values()][0].filter).toBe('aggregate_type=eq."billing,invoice",type=eq.Paid');
    });
});
