# Event Store

A production-ready, high-performance Event Sourcing library for Supabase with built-in caching (in-memory by default, Redis optional). Built with TypeScript and following the Ports & Adapters (Hexagonal) architecture pattern.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

## Features

✨ **Core Event Sourcing**
- 📝 Event appending (single & batch)
- 🔍 Flexible event querying with filters
- 📊 Aggregate event streams
- 🔢 Automatic sequence number management
- ✅ Event stream validation

🚀 **Advanced Features**
- 📸 Snapshot management for performance optimization
- 🔄 Event replay with projections
- ⏱️ Point-in-time state reconstruction
- 📈 Aggregate statistics and analytics
- 🔴 Real-time event subscriptions

⚡ **Performance**
- 🧠 In-memory cache out of the box – no Redis required
- 🔁 Incremental loading: cached aggregates only fetch events they have not seen yet
- 🎯 Optional database functions: appends and aggregate loads in a single round trip
- 🤝 Concurrent identical reads share one database request
- 🔴 Redis (optional) as a shared cache for several instances

🏗️ **Architecture**
- 🔌 Ports & Adapters (Hexagonal Architecture)
- 🧪 Fully testable with dependency injection
- 🔄 Swappable adapters (Supabase, custom implementations)
- 📐 Type-safe with full TypeScript support

## Installation

```bash
npm install @beatbrackerz/eventstore @supabase/supabase-js
```

`@supabase/supabase-js` (≥ 2.91) is a peer dependency. For a cache shared between several instances, also install `ioredis` (optional). Requires Node.js 22 or newer.

## Quick Start

### 1. Database Setup

Run [`sql/eventstore.sql`](sql/eventstore.sql) in the Supabase SQL editor, with `psql`, or as a migration (`supabase migration new eventstore`). The file is also shipped in the package: `node_modules/@beatbrackerz/eventstore/sql/eventstore.sql`.

It creates

- the tables `events`, `aggregate_sequences` and `snapshots` (only if they do not exist yet),
- the indexes the library's queries need, including a unique index on `(aggregate_id, aggregate_type, sequence_number)`,
- three database functions: `es_append_events`, `es_load_stream` and `es_aggregate_stats`.

The script is safe to run on existing installations and safe to run again. The functions run with the caller's privileges, so grants and row level security apply as for direct table access.

**Existing installations:** the library keeps working without the script, but is considerably slower (see [Performance](#performance)) and allocates sequence numbers without locking, so concurrent appends to the same aggregate can produce duplicate sequence numbers. The library detects the functions automatically; no code change is needed after running the script. If your `events` table already contains duplicate sequence numbers, the script creates a non-unique index instead and prints a warning with a query to find them.

### 2. Basic Usage

```typescript
import { createEventStore } from '@beatbrackerz/eventstore';
import { createClient } from '@supabase/supabase-js';

// Initialize Supabase client
const supabase = createClient(
  'https://your-project.supabase.co',
  'your-anon-key'
);

// Create event store (uses the built-in in-memory cache)
const eventStore = createEventStore({
  supabase,
  enablePublisher: true,
});

// Append an event (aggregate_id and created_by are UUIDs)
const orderId = crypto.randomUUID();
const event = await eventStore.appendEvent({
  type: 'OrderCreated',
  aggregate_id: orderId,
  aggregate_type: 'order',
  created_by: '40c80bde-aeae-4943-a15f-167df8d85ddd', // the acting user, e.g. a Supabase auth user id
  payload: {
    customerId: 'customer-456',
    items: [{ productId: 'product-789', quantity: 2 }],
    totalAmount: 99.99,
  },
  metadata: {
    ipAddress: '192.168.1.1',
    userAgent: 'Mozilla/5.0...',
  },
});

console.log('Event created:', event);
```

### 3. With Redis Cache

A Redis cache is shared by all instances of your application. Without it, each instance keeps its own in-memory cache (see [Caching & Consistency](#caching--consistency)).

```typescript
import { Redis } from 'ioredis';

// Initialize Redis client
const redis = new Redis({
  host: 'localhost',
  port: 6379,
  password: 'your-redis-password', // optional
});

// Create event store with caching
const eventStore = createEventStore({
  supabase,
  redis,
  cache: {
    ttl: {
      events: 3600,        // 1 hour
      snapshots: 7200,     // 2 hours
      sequences: 300,      // 5 minutes
      aggregateEvents: 1800, // 30 minutes
    },
    keyPrefix: 'myapp:es:',
  },
  enablePublisher: true,
});
```

## Usage Examples

### Writing Events

#### Single Event

```typescript
const event = await eventStore.appendEvent({
  type: 'UserRegistered',
  aggregate_id: userId,
  aggregate_type: 'user',
  created_by: '00000000-0000-0000-0000-000000000000', // e.g. a fixed UUID for system events
  payload: {
    email: 'user@example.com',
    name: 'John Doe',
  },
});
```

#### Batch Events

```typescript
const events = await eventStore.appendEvents([
  {
    type: 'ProductCreated',
    aggregate_id: productId,
    aggregate_type: 'product',
    created_by: adminId,
    payload: { name: 'Laptop', price: 999.99 },
  },
  {
    type: 'InventoryUpdated',
    aggregate_id: productId,
    aggregate_type: 'product',
    created_by: adminId,
    payload: { quantity: 100 },
  },
]);
```

### Reading Events

#### Get All Events for an Aggregate

```typescript
const events = await eventStore.getAggregateEvents(
  orderId,
  'order'
);

console.log(`Found ${events.length} events`);
```

#### Query Events with Filters

```typescript
const events = await eventStore.queryEvents({
  aggregate_type: 'order',
  type: 'OrderShipped',
  from_sequence: 10,
  to_sequence: 50,
  limit: 20,
  order: 'desc',
});
```

#### Get Events by Type

```typescript
// Most recent events first
const recentOrders = await eventStore.getEventsByType(
  'OrderCreated',
  10 // limit
);
```

### Snapshots

#### Create a Snapshot

```typescript
const currentState = {
  orderId,
  status: 'confirmed',
  items: [...],
  totalAmount: 299.99,
};

const snapshot = await eventStore.createSnapshot({
  aggregate_id: orderId,
  aggregate_type: 'order',
  sequence_number: 42,
  state: currentState,
});
```

#### Get Latest Snapshot

```typescript
const snapshot = await eventStore.getLatestSnapshot(
  orderId,
  'order'
);

if (snapshot) {
  console.log('Restored state from sequence:', snapshot.sequence_number);
  console.log('State:', snapshot.state);
}
```

#### Prune Old Snapshots

```typescript
// Keep only the 3 most recent snapshots
const deletedCount = await eventStore.pruneSnapshots(
  orderId,
  'order',
  3
);

console.log(`Deleted ${deletedCount} old snapshots`);
```

### Event Replay & Projections

#### Define a Projection

```typescript
interface OrderState {
  id: string;
  status: 'pending' | 'confirmed' | 'shipped' | 'delivered';
  items: Array<{ productId: string; quantity: number }>;
  totalAmount: number;
  createdAt?: string;
  shippedAt?: string;
}

const orderProjection: EventProjection<OrderState> = {
  initialState: {
    id: '',
    status: 'pending',
    items: [],
    totalAmount: 0,
  },
  applyEvent: (state, event) => {
    switch (event.type) {
      case 'OrderCreated':
        return {
          ...state,
          id: event.aggregate_id,
          items: event.payload.items,
          totalAmount: event.payload.totalAmount,
          createdAt: event.created_at,
        };
      
      case 'OrderConfirmed':
        return {
          ...state,
          status: 'confirmed',
        };
      
      case 'OrderShipped':
        return {
          ...state,
          status: 'shipped',
          shippedAt: event.created_at,
        };
      
      case 'OrderDelivered':
        return {
          ...state,
          status: 'delivered',
        };
      
      default:
        return state;
    }
  },
};
```

#### Replay Events

```typescript
// Get current state by replaying all events
const currentState = await eventStore.replayEvents(
  orderId,
  'order',
  orderProjection
);

console.log('Current order state:', currentState);
```

#### Point-in-Time State

```typescript
// Get state at specific sequence number
const pastState = await eventStore.getStateAtSequence(
  orderId,
  'order',
  orderProjection,
  25 // sequence number
);

console.log('Order state at sequence 25:', pastState);
```

#### Rebuild with Automatic Snapshots

```typescript
// Rebuild state and create snapshots every 50 events
const finalState = await eventStore.rebuildWithSnapshots(
  orderId,
  'order',
  orderProjection,
  50 // snapshot interval
);
```

#### Stream Processing

```typescript
// Process events in batches
await eventStore.replayEventStream(
  { aggregate_type: 'order' },
  async (events, batchNumber) => {
    console.log(`Processing batch ${batchNumber}: ${events.length} events`);
    
    // Update read model, send notifications, etc.
    for (const event of events) {
      await updateReadModel(event);
    }
  },
  100 // batch size
);
```

### Real-time Subscriptions

```typescript
// Subscribe to all events
const unsubscribe = eventStore.subscribeToEvents((event) => {
  console.log('New event:', event.type, event.aggregate_id);
});

// Subscribe with filters
const unsubscribeOrders = eventStore.subscribeToEvents(
  (event) => {
    console.log('New order event:', event);
    // Handle event in real-time
  },
  {
    aggregate_type: 'order',
    type: 'OrderCreated',
  }
);

// Unsubscribe when done
unsubscribe();
unsubscribeOrders();
```

### Statistics & Analytics

```typescript
const stats = await eventStore.getAggregateStats(
  orderId,
  'order'
);

console.log('Total events:', stats.totalEvents);
console.log('First event:', stats.firstEvent?.type);
console.log('Last event:', stats.lastEvent?.type);

// Event type distribution
stats.eventTypes.forEach((count, type) => {
  console.log(`${type}: ${count} events`);
});
```

### Stream Validation

```typescript
const validation = await eventStore.validateEventStream(
  orderId,
  'order'
);

if (!validation.valid) {
  console.error('Event stream has issues:');
  validation.issues.forEach(issue => console.error('- ', issue));
} else {
  console.log('Event stream is valid ✓');
}
```

### Cache Management

```typescript
// Warm up cache for frequently accessed aggregate
await eventStore.warmupCache(orderId, 'order');

// Clear cache for specific aggregate
await eventStore.clearAggregateCache(orderId, 'order');

// Clear all cache
await eventStore.clearCache();

// Get cache statistics
const cacheStats = await eventStore.getCacheStats();
console.log('Cache enabled:', cacheStats.enabled);
console.log('Cache type:', cacheStats.type);
if (cacheStats.info) {
  console.log('Cached keys:', cacheStats.info.keys);
  console.log('Memory usage:', cacheStats.info.memory);
}
```

## Advanced Usage

### Custom Adapters

You can implement custom adapters for different databases or caching systems:

```typescript
import { 
  IEventRepository, 
  ISequenceRepository,
  ICacheService,
  EventStore 
} from '@beatbrackerz/eventstore';

// Custom MongoDB Event Repository
class MongoDBEventRepository implements IEventRepository {
  constructor(private db: MongoClient) {}
  
  async saveEvent(event, sequenceNumber) {
    // MongoDB-specific implementation
  }
  
  // ... implement other methods
}

// Custom Memcached Cache Service
class MemcachedCacheService implements ICacheService {
  constructor(private memcached: Memcached) {}
  
  async get<T>(key: string): Promise<T | null> {
    // Memcached-specific implementation
  }
  
  // ... implement other methods
}

// Optional fast paths such as IEventRepository.appendEvents or loadStream can be
// implemented as well; without them the EventStore falls back to the required methods.

// Create event store with custom adapters
const customEventStore = new EventStore({
  eventRepository: new MongoDBEventRepository(mongoClient),
  sequenceRepository: new CustomSequenceRepository(),
  snapshotRepository: new CustomSnapshotRepository(),
  cacheService: new MemcachedCacheService(memcached),
});
```

### Testing

The Ports & Adapters architecture makes testing easy:

```typescript
import { EventStore, IEventRepository, NoOpCacheService } from '@beatbrackerz/eventstore';

// Mock repository for testing
class MockEventRepository implements IEventRepository {
  private events: EventRecord[] = [];
  
  async saveEvent(event, sequenceNumber) {
    const record = {
      id: crypto.randomUUID(),
      ...event,
      sequence_number: sequenceNumber,
      created_at: new Date().toISOString(),
    };
    this.events.push(record);
    return record;
  }
  
  async findEvents(options) {
    return this.events.filter(e => {
      if (options.aggregate_id && e.aggregate_id !== options.aggregate_id) {
        return false;
      }
      return true;
    });
  }
  
  // ... implement other methods
}

// Use in tests
describe('EventStore', () => {
  it('should append event', async () => {
    const eventStore = new EventStore({
      eventRepository: new MockEventRepository(),
      sequenceRepository: new MockSequenceRepository(),
      snapshotRepository: new MockSnapshotRepository(),
      cacheService: new NoOpCacheService(),
    });
    
    const event = await eventStore.appendEvent({
      type: 'TestEvent',
      aggregate_id: crypto.randomUUID(),
      aggregate_type: 'test',
      created_by: crypto.randomUUID(),
    });
    
    expect(event.type).toBe('TestEvent');
  });
});
```

## Performance

Measured with [`bench/run.ts`](bench/run.ts) against a real PostgREST (as used by Supabase) with 20 ms of simulated network latency per request. Times are per operation.

| Operation | 1.1.1 | 1.2, without SQL script | 1.2, with SQL script | 1.2, with SQL script and `maxStalenessMs: 2000` |
|---|---:|---:|---:|---:|
| Append one event | 75 ms · 3 requests | 76 ms · 3 requests | **27 ms · 1 request** | **27 ms · 1 request** |
| Load an aggregate (replay, snapshot + 10 events), first time | 50 ms · 2 requests | 54 ms · 2 requests | **27 ms · 1 request** | **26 ms · 1 request** |
| Load the same aggregate again | 50 ms · 2 requests · 5.3 KB | **25 ms · 1 request · 0 KB** | **24 ms · 1 request · 0 KB** | **< 0.1 ms · no request** |
| Read 60 events of an aggregate again | 25 ms · 30 KB | 25 ms · 0 KB | 24 ms · 0 KB | **< 0.1 ms · no request** |
| 10 concurrent reads of the same aggregate | 10 requests · 304 KB | **1 request · 30 KB** | **1 request · 30 KB** | **1 request · 30 KB** |
| Statistics of an aggregate with 2,500 events | wrong result¹ | 149 ms · 5 requests² | **31 ms · 1 request · 34 KB** | **30 ms · 1 request · 34 KB** |
| Read an aggregate with 2,500 events | wrong result¹ | 142 ms · 4 requests² | **77 ms · 1 request** | **67 ms · 1 request** |

¹ 1.1.1 silently stops at PostgREST's row limit (1,000 on Supabase): it returned 1,000 events and `totalEvents = 1000`.
² Includes a one-time request per process that detects the missing database functions.

The gains come from round trips, so they grow with the latency between your application and Supabase. By default every read still checks the database for new events (one small request that usually returns nothing); `maxStalenessMs` trades that check for a bounded delay, see below.

## Architecture

```
┌─────────────────────────────────────────┐
│         Application Layer               │
│         (EventStore Service)            │
│      Business Logic & Orchestration     │
└────────────┬────────────────────────────┘
             │
        ┌────┴────┐
        │  Ports  │ (Interfaces)
        └────┬────┘
             │
    ┌────────┴────────────────────────┐
    │          Adapters               │
    │                                 │
    ├─ SupabaseEventRepository        │
    ├─ SupabaseSequenceRepository     │
    ├─ SupabaseSnapshotRepository     │
    ├─ SupabaseEventPublisher         │
    ├─ MemoryCacheService (default)   │
    ├─ RedisCacheService              │
    └─ NoOpCacheService               │
    └─────────────────────────────────┘
```

## Best Practices

### 1. Event Design
```typescript
// ✅ Good: Specific, immutable events
{
  type: 'OrderItemAdded',
  payload: {
    orderId: 'order-123',
    productId: 'product-456',
    quantity: 2,
    priceAtTime: 29.99,
  }
}

// ❌ Bad: Generic, mutable events
{
  type: 'OrderUpdated',
  payload: { changes: {...} }
}
```

### 2. Snapshot Strategy
```typescript
// Create snapshots every 50-100 events
const SNAPSHOT_INTERVAL = 50;

// After processing events
if (eventCount % SNAPSHOT_INTERVAL === 0) {
  await eventStore.createSnapshot({
    aggregate_id,
    aggregate_type,
    sequence_number: currentSequence,
    state: currentState,
  });
}

// Keep only recent snapshots
await eventStore.pruneSnapshots(aggregate_id, aggregate_type, 3);
```

### 3. Cache Warming
```typescript
// Warm up cache for frequently accessed aggregates on startup
const popularOrderIds = await getPopularOrders();

await Promise.all(
  popularOrderIds.map(id => 
    eventStore.warmupCache(id, 'order')
  )
);
```

### 4. Error Handling
```typescript
try {
  await eventStore.appendEvent({...});
} catch (error) {
  if (error instanceof EventStoreError) {
    console.error('Event store error:', error.message);
    console.error('Caused by:', error.cause);
  }
  throw error;
}
```

## Configuration

### Redis Configuration

```typescript
import { Cluster, Redis } from 'ioredis';

// Standalone
const redis = new Redis({
  host: 'localhost',
  port: 6379,
  password: 'secret',
  db: 0,
});

// Cluster
const redis = new Cluster([
  { host: 'node1', port: 6379 },
  { host: 'node2', port: 6379 },
]);

// Sentinel
const redis = new Redis({
  sentinels: [
    { host: 'sentinel1', port: 26379 },
    { host: 'sentinel2', port: 26379 },
  ],
  name: 'mymaster',
});
```

### Caching & Consistency

Without Redis, every `EventStore` keeps a bounded in-memory LRU cache. Because events are immutable and only ever appended, a cached aggregate never becomes wrong – it can only fall behind. Reads therefore ask the database only for events newer than the cached ones, and `maxStalenessMs` controls how often they ask:

| `maxStalenessMs` | Behaviour | Use when |
|---|---|---|
| `0` (default without Redis) | Every read checks for newer events with one small query | Several instances or serverless functions write to the same aggregates |
| e.g. `2000` | Reads within 2 s after the last check are served from memory without a request | A short delay for changes made by *other* instances is acceptable |
| `Infinity` | The cache is only updated by this instance's own writes and TTL expiry | A single instance writes all events |

Writes made through an `EventStore` update its own cache immediately, whatever the setting. With Redis, plain reads trust the shared cache as in previous versions (appends from any instance invalidate it), while replays always check for newer events; setting `maxStalenessMs` applies one policy to both.

```typescript
const eventStore = createEventStore({
  supabase,
  cache: {
    maxStalenessMs: 2000,
    memory: {
      maxEntries: 10_000,           // default
      maxSizeBytes: 64 * 1024 ** 2, // default: 64 MiB
    },
  },
});
```

Create the `EventStore` once and reuse it: the in-memory cache lives in the instance. If you use user-scoped Supabase clients with row level security, do not share an `EventStore` – or a Redis cache – between users who may see different data.

### Options of `createEventStore`

| Option | Default | Description |
|---|---|---|
| `supabase` | – | Supabase client |
| `redis` | – | Redis client (e.g. `ioredis`); enables the shared Redis cache |
| `cache.enabled` | `true` | `false` disables caching |
| `cache.maxStalenessMs` | see above | Consistency of cached reads |
| `cache.ttl` | see below | TTLs in seconds per cache type |
| `cache.keyPrefix` | `'es:'` | Prefix of all cache keys |
| `cache.memory` | 10,000 entries / 64 MiB | Limits of the in-memory cache |
| `enablePublisher` | `false` | Enables `subscribeToEvents` |
| `rpc` | `'auto'` | Use the database functions: `'auto'` detects them, `true` requires them, `false` never uses them |
| `pageSize` | `1000` | Rows per request when paging; must not exceed PostgREST's `max-rows` |

### Cache TTL Strategy

```typescript
const eventStore = createEventStore({
  supabase,
  redis,
  cache: {
    ttl: {
      events: 3600,          // Individual events: 1 hour
      snapshots: 7200,       // Snapshots: 2 hours (longer, less frequent changes)
      sequences: 300,        // Sequences: 5 minutes (shorter, frequent updates)
      aggregateEvents: 1800, // Aggregate lists: 30 minutes
    },
    keyPrefix: 'prod:es:',   // Namespace your keys
  },
});
```

## Upgrading from 1.1

The public API is unchanged. Behaviour changes to be aware of:

- **Caching is on by default** (in-memory, always consistent). Disable it with `cache: { enabled: false }`.
- **Dependencies:** `ioredis` is no longer installed with the package and `@supabase/supabase-js` is a peer dependency. Node.js 22 or newer is required.
- **Complete results:** reads no longer stop silently at PostgREST's row limit (1,000 on Supabase). This affects `getAggregateEvents`, replays, `getAggregateStats`, `validateEventStream` and `queryEvents` without `limit` – which now returns *all* matching events.
- `getEventsByType` returns the most recent events first (by `created_at`); previously it sorted by the per-aggregate sequence number.
- `replayEventStream` starts at `from_sequence` (previously `from_sequence + 1`) and no longer skips events of streams spanning several aggregates.
- `replayEvents` with `to_sequence` and `getStateAtSequence` start from the latest snapshot *at or before* that sequence; previously a newer snapshot could yield a later state.
- `rebuildWithSnapshots` stores its snapshots in one request and no longer writes the last one twice.
- `subscribeToEvents` supports several subscriptions at once (with current supabase-js the second one threw).
- Redis uses `SCAN`/`UNLINK` instead of the blocking `KEYS`/`DEL`. Cached aggregate streams use new keys; old entries expire with their TTL.
- Custom `ICacheService` implementations now receive writes; previously only `RedisCacheService` did.
- All types, ports and adapters are exported from the package root.

## API Reference

`createEventStore`, `EventStore` and the types, ports and adapters are exported from the package root ([`src/index.ts`](src/index.ts)). They are documented with TSDoc comments in the sources – the `EventStore` methods in [`src/app/EventStore.ts`](src/app/EventStore.ts) – and in the type declarations shipped with the package, so editors show the documentation on hover.

## Contributing

Contributions are welcome! Please read our [Contributing Guide](CONTRIBUTING.md) for details.

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Support

- 📧 Email: yhammer@vh-agency.de
- 🐛 Issues: [GitHub Issues](https://github.com/beatbrackerz/eventstore/issues)

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for version history.

---

Made with ❤️ by Visionary Hive Agency