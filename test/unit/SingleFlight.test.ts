import {describe, expect, it} from 'vitest';
import {SingleFlight} from '../../src/app/SingleFlight.js';

describe('SingleFlight', () => {
    it('runs concurrent calls with the same key once and gives every caller its own copy', async () => {
        const flights = new SingleFlight();
        let runs = 0;
        const work = async () => {
            runs++;
            await new Promise(resolve => setTimeout(resolve, 5));
            return { items: [1] };
        };

        const results = await Promise.all([
            flights.run('k', work),
            flights.run('k', work),
            flights.run('k', work),
        ]);

        expect(runs).toBe(1);
        results[0].items.push(2);
        expect(results[1]).toEqual({ items: [1] });
        expect(results[2]).toEqual({ items: [1] });
        expect(results[1]).not.toBe(results[2]);
    });

    it('runs again once the previous call has finished', async () => {
        const flights = new SingleFlight();
        let runs = 0;
        await flights.run('k', async () => ++runs);
        await flights.run('k', async () => ++runs);
        expect(runs).toBe(2);
    });

    it('rejects all waiters when the work fails and frees the key', async () => {
        const flights = new SingleFlight();
        const failing = () => new Promise<never>((_, reject) => setTimeout(() => reject(new Error('boom')), 5));

        const results = await Promise.allSettled([flights.run('k', failing), flights.run('k', failing)]);
        expect(results.map(r => r.status)).toEqual(['rejected', 'rejected']);

        await expect(flights.run('k', async () => 'ok')).resolves.toBe('ok');
    });

    it('keeps different keys independent', async () => {
        const flights = new SingleFlight();
        let runs = 0;
        await Promise.all([flights.run('a', async () => ++runs), flights.run('b', async () => ++runs)]);
        expect(runs).toBe(2);
    });
});
