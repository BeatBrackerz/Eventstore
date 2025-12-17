# Event Store

A production-ready, high-performance Event Sourcing library for Supabase with Redis caching support. Built with TypeScript and following the Ports & Adapters (Hexagonal) architecture pattern.

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
- 🎯 Redis caching (optional) with 95-99% latency reduction
- 🔢 Batch operations with automatic sequence reservation
- 📦 Pipeline-based cache operations
- 🎨 Configurable TTL per cache type

🏗️ **Architecture**
- 🔌 Ports & Adapters (Hexagonal Architecture)
- 🧪 Fully testable with dependency injection
- 🔄 Swappable adapters (Supabase, custom implementations)
- 📐 Type-safe with full TypeScript support

## Installation

```bash
npm install @beatbrackerz/eventstore
```

### Peer Dependencies

```bash
npm install @supabase/supabase-js ioredis
```

## Quick Start

### 1. Database Setup

Create the required tables in your Supabase database:

```sql
-- Events table
CREATE TABLE public.events (
  id UUID NOT NULL DEFAULT extensions.uuid_generate_v4(),
  type VARCHAR(255) NOT NULL,
  aggregate_id UUID NOT NULL,
  aggregate_type VARCHAR(255) NOT NULL,
  sequence_number INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  created_by UUID NOT NULL,
  CONSTRAINT events_pkey PRIMARY KEY (id)
);

CREATE INDEX idx_events_aggregate_id ON public.events USING btree (aggregate_id);
CREATE INDEX idx_events_aggregate_type ON public.events USING btree (aggregate_type);
CREATE INDEX idx_events_type ON public.events USING btree (type);

-- Sequence management table
CREATE TABLE public.aggregate_sequences (
  aggregate_id UUID NOT NULL,
  aggregate_type VARCHAR(255) NOT NULL,
  last_sequence INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT aggregate_sequences_pkey PRIMARY KEY (aggregate_id, aggregate_type)
);

-- Snapshots table
CREATE TABLE public.snapshots (
  id UUID NOT NULL DEFAULT extensions.uuid_generate_v4(),
  aggregate_id UUID NOT NULL,
  aggregate_type VARCHAR(255) NOT NULL,
  sequence_number INTEGER NOT NULL,
  state JSONB NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT snapshots_pkey PRIMARY KEY (id)
);

CREATE INDEX idx_snapshots_aggregate ON public.snapshots 
  USING btree (aggregate_id, aggregate_type, sequence_number DESC);
```

### 2. Basic Usage

```typescript
import { createEventStore } from '@beatbrackerz/eventstore';
import { createClient } from '@supabase/supabase-js';

// Initialize Supabase client
const supabase = createClient(
  'https://your-project.supabase.co',
  'your-anon-key'
);

// Create event store (without cache)
const eventStore = createEventStore({
  supabase,
  enablePublisher: true,
});

// Append an event
const event = await eventStore.appendEvent({
  type: 'OrderCreated',
  aggregate_id: '123e4567-e89b-12d3-a456-426614174000',
  aggregate_type: 'order',
  created_by: 'user-123',
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

```typescript
import Redis from 'ioredis';

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
  created_by: 'system',
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
    created_by: 'admin-123',
    payload: { name: 'Laptop', price: 999.99 },
  },
  {
    type: 'InventoryUpdated',
    aggregate_id: productId,
    aggregate_type: 'product',
    created_by: 'admin-123',
    payload: { quantity: 100 },
  },
]);
```

### Reading Events

#### Get All Events for an Aggregate

```typescript
const events = await eventStore.getAggregateEvents(
  'order-123',
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
const recentOrders = await eventStore.getEventsByType(
  'OrderCreated',
  10 // limit
);
```

### Snapshots

#### Create a Snapshot

```typescript
const currentState = {
  orderId: 'order-123',
  status: 'confirmed',
  items: [...],
  totalAmount: 299.99,
};

const snapshot = await eventStore.createSnapshot({
  aggregate_id: 'order-123',
  aggregate_type: 'order',
  sequence_number: 42,
  state: currentState,
});
```

#### Get Latest Snapshot

```typescript
const snapshot = await eventStore.getLatestSnapshot(
  'order-123',
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
  'order-123',
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
  'order-123',
  'order',
  orderProjection
);

console.log('Current order state:', currentState);
```

#### Point-in-Time State

```typescript
// Get state at specific sequence number
const pastState = await eventStore.getStateAtSequence(
  'order-123',
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
  'order-123',
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
  'order-123',
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
  'order-123',
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
await eventStore.warmupCache('order-123', 'order');

// Clear cache for specific aggregate
await eventStore.clearAggregateCache('order-123', 'order');

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
import { EventStore, IEventRepository } from '@beatbrackerz/eventstore';

// Mock repository for testing
class MockEventRepository implements IEventRepository {
  private events: EventRecord[] = [];
  
  async saveEvent(event, sequenceNumber) {
    const record = {
      id: `test-${Date.now()}`,
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
      aggregate_id: 'test-123',
      aggregate_type: 'test',
      created_by: 'tester',
    });
    
    expect(event.type).toBe('TestEvent');
  });
});
```

## Performance

### Without Cache
- Aggregate Events: ~50-200ms (Database query)
- Snapshots: ~30-100ms
- Stats: ~100-300ms

### With Redis Cache
- Aggregate Events: ~1-5ms (Cache hit)
- Snapshots: ~1-3ms
- Stats: ~1-3ms

**Cache hit provides 95-99% latency reduction!**

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
import Redis from 'ioredis';

// Standalone
const redis = new Redis({
  host: 'localhost',
  port: 6379,
  password: 'secret',
  db: 0,
});

// Cluster
const redis = new Redis.Cluster([
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

## API Reference

See [API Documentation](./docs/API.md) for complete API reference.

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