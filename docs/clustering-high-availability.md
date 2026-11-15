# Clustering & High Availability

> **Enterprise Topology Reference**: Multi-Node Redis Cluster, Sentinel Failover, Sharded Pub/Sub, Pluggable `@redis/client` Drivers, and Multi-Region Cross-Cluster Invalidation Relays.

---

## 1. Redis Cluster (Slot-Based Sharding)

In high-throughput distributed architectures, running a multi-node **Redis Cluster** (e.g., AWS ElastiCache Cluster Mode Enabled or Azure Managed Redis) partitions your key space across 16,384 hash slots.

TriCache integrates natively with Redis Cluster topologies via `redisClusterNodes`:

```typescript
import { CacheService } from 'tricache';

const cache = CacheService.create({
  redisClusterNodes: [
    { host: 'redis-node-1.internal', port: 6379 },
    { host: 'redis-node-2.internal', port: 6379 },
    { host: 'redis-node-3.internal', port: 6379 },
  ],
  redisTls: true,
  useShardedPubSub: true, // Recommended for Redis 7+
});
```

### Topology Discovery & Slot Routing
* **Auto-Discovery**: You only need to supply an initial subset of cluster nodes. TriCache queries `CLUSTER SLOTS` on startup and dynamically maps the complete cluster topology.
* **Automatic Redirect Handling**: Handles `MOVED` and `ASK` redirects transparently during live slot migrations and cluster rebalancing with zero dropped commands.
* **Hash Tag Scoping**: The default stream key uses `{<namespace>}`. Ordinary data/tag keys can span slots; batch operations group commands by owning master and avoid cross-slot transactions.

---

## 2. Sharded Pub/Sub (`useShardedPubSub: true`)

Traditional Redis Pub/Sub (`PUBLISH` / `SUBSCRIBE`) broadcasts messages across **every single node** in a Redis cluster over the inter-node cluster bus, causing significant CPU and network gossip amplification under heavy invalidation load.

When `useShardedPubSub: true` is enabled on Redis 7+ or Valkey:

```typescript
const cache = CacheService.create({
  redisClusterNodes: [/* ... */],
  useShardedPubSub: true,
});
```

### How Sharded Pub/Sub Optimizes Fleet Throughput:
1. **Shard-Bound Routing (`SPUBLISH` / `SSUBSCRIBE`)**: Messages are bound directly to the slot containing the `{namespace}` hash tag.
2. **Gossip Elimination**: Broadcasts are constrained exclusively to the specific primary and replica nodes owning that hash slot.
3. **CPU Preservation**: Cluster bus traffic drops to near zero, freeing cluster bus threads for high-volume read/write workloads.

---

## 3. Redis Sentinel (Automatic Primary Failover)

For non-clustered, high-availability Redis setups utilizing Sentinel quorums, TriCache monitors master elections and automatically fails over without service interruption:

```typescript
import { CacheService } from 'tricache';

const cache = CacheService.create({
  redisSentinel: {
    name: 'mymaster',
    sentinels: [
      { host: 'sentinel-1.internal', port: 26379 },
      { host: 'sentinel-2.internal', port: 26379 },
      { host: 'sentinel-3.internal', port: 26379 },
    ],
  },
  redisTls: true,
});
```

### Sentinel Resilience Properties:
* **Dynamic Master Resolution**: TriCache queries the Sentinel pool for the current active master and reconnects automatically when failovers occur.
* **Dedicated Subscriber Reconnection**: The invalidation backplane client reconnects concurrently with the primary command client, resynchronizing in-flight stream sequences.
* **Precedence Rule**: `redisClusterNodes` takes precedence over `redisSentinel`, which in turn takes precedence over static `redisHost`/`redisPort`.

---

## 4. Wire Protocol Switching: RESP3 vs. RESP2

TriCache defaults to the modern **RESP3** wire protocol (`redisProtocol: 3`) for structured type parsing and streaming.

However, if your infrastructure routes Redis traffic through intermediate proxies (such as **Twemproxy**, **Envoy Redis proxy filter**, or older AWS ElastiCache Serverless proxy endpoints that reject the `HELLO 3` handshake), set `redisProtocol: 2`:

```typescript
const cache = CacheService.create({
  redisHost: 'envoy-redis-proxy.internal',
  redisProtocol: 2, // Forces RESP2 wire protocol
});
```

---

## 5. Pluggable Redis Driver (`@redis/client` / `node-redis`)

Organizations standardizing on `@redis/client` (`npm:redis`), AWS ElastiCache IAM authentication, or Azure Managed Identity can plug their existing connection pools directly into TriCache without maintaining duplicate socket connections:

```typescript
import { createClient } from 'redis';
import { CacheService, createNodeRedisAdapter } from 'tricache';

// 1. Initialize your company-standard node-redis client (e.g. with AWS IAM)
const nodeRedisClient = createClient({
  url: 'redis://prod-cluster.internal:6379',
});
await nodeRedisClient.connect();

// 2. Wrap and pass directly to TriCache with zero runtime overhead
const cache = CacheService.create({
  redisClient: createNodeRedisAdapter(nodeRedisClient),
  // Optional: pass a dedicated subscriber or let TriCache duplicate automatically
  redisSubClient: createNodeRedisAdapter(nodeRedisClient.duplicate()),
});
```

### Adapter Architecture & Features
* **Zero Runtime Dependencies**: Implemented via structural duck-typing; zero external runtime dependencies added to TriCache.
* **Tuple-Normalized Replies**: Atomic `.multi()` transactions and non-transactional, same-tick command batches preserve per-command `[error, result]` replies. A failed command does not hide successful replies or trigger unsafe replay of writes.
* **Safe Teardown**: `cache.destroy()` gracefully disconnects internal listeners while leaving your external shared connection pool open.

### Delivery and expiry boundaries

- Call `await cache.ready()` before serving traffic. Readiness finishes the initial backplane attempt; inspect `cache.health()` for degraded transport state.
- Streams replay retained events from concrete cursors, including cursors saved in snapshots. If retention has removed the cursor or events are missing, local state is conservatively flushed. Redis persistence, replication, and retention policy determine durability.
- `awaitInvalidationBackplane: true` awaits publication and reports failures. It does not wait for every peer to apply an event, and is not exactly-once delivery. Cross-region callers should implement durable retry where required.
- Regional relay receivers invalidate their regional L2 as well as local tiers. Regional generation counters advance monotonically even when an incoming region's counter is smaller.
- Cold Redis reads preserve remaining TTL through atomic value/PTTL reads where supported. Custom drivers without those capabilities use bounded fallback TTLs.

---

## 6. Multi-Cluster Cross-Region Invalidation Relay

In multi-region cloud architectures (e.g. `us-east-1` + `eu-central-1`), maintaining independent regional Redis clusters is standard practice to preserve $<1\text{ ms}$ read/write latencies. However, when an invalidation or mutation occurs in one region, other regions remain stale without multi-master synchronization.

TriCache includes an enterprise **Cross-Region Invalidation Relay** that synchronizes `del`, `del-glob`, and generational `tag_incr` events across independent regional clusters:

![Multi-Cluster Cross-Region Invalidation Relay Architecture](/docs/Cross-Region_Relay_Architecture_…_20260910215902.jpeg)

::: details Relay Topology Diagram
```
┌─────────────────────────┐               ┌─────────────────────────┐
│   Region: us-east-1     │               │   Region: eu-central-1  │
│  ┌───────────────────┐  │               │  ┌───────────────────┐  │
│  │ Local TriCache    │  │               │  │ Local TriCache    │  │
│  │ L1 RAM + L1.5 Disk│  │               │  │ L1 RAM + L1.5 Disk│  │
│  └─────────┬─────────┘  │               │  └─────────▲─────────┘  │
│            │            │               │            │            │
│  ┌─────────▼─────────┐  │               │  ┌─────────┴─────────┐  │
│  │ Local Redis Cluster  │  │               │  │ Local Redis Cluster  │  │
│  └─────────┬─────────┘  │               │  └───────────────────┘  │
└────────────┼────────────┘               └─────────────────────────┘
             │                                         ▲
             │  Cross-Region Relay (HTTP/SNS/Kafka)    │
             └─────────────────────────────────────────┘
                   Loop-Prevented / Deduplicated
```
:::

### 1. Zero-Dependency HTTP Webhook Mesh

Connect regional peer endpoints directly using Node 22 native `fetch()` over VPC peering or service meshes:

```typescript
import { CacheService, createHttpMeshRelay, createCrossRegionWebhookHandler } from 'tricache';

const cache = CacheService.create({
  crossRegion: {
    currentRegion: process.env.AWS_REGION || 'us-east-1',
    relay: createHttpMeshRelay({
      peerUrls: ['https://eu.internal.api/cache/invalidation'],
      authSecret: process.env.CROSS_REGION_SECRET,
      timeoutMs: 3000,
    }),
    authSecret: process.env.CROSS_REGION_SECRET,
  },
});

// Framework-agnostic webhook receiver (Express / Fastify / Next.js / Node http)
const webhookHandler = createCrossRegionWebhookHandler(cache, {
  authSecret: process.env.CROSS_REGION_SECRET,
});

app.post('/cache/invalidation', async (req, res) => {
  const result = await webhookHandler({ headers: req.headers, body: req.body });
  res.status(result.status).json(result.body);
});
```

### 2. Message Broker Relay (AWS SNS/SQS, EventBridge, Kafka, NATS)

For decoupled event-driven cloud architectures:

```typescript
import { CacheService, createCustomCrossRegionRelay } from 'tricache';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';

const sns = new SNSClient({ region: 'us-east-1' });

const snsRelay = createCustomCrossRegionRelay({
  async broadcast(event) {
    await sns.send(new PublishCommand({
      TopicArn: 'arn:aws:sns:us-east-1:123456789012:global-cache-invalidation',
      Message: JSON.stringify(event),
    }));
  },
});

const cache = CacheService.create({
  crossRegion: {
    currentRegion: 'us-east-1',
    relay: snsRelay,
  },
});

// In your regional SQS / Kafka consumer:
sqsConsumer.on('message', async (msg) => {
  const event = JSON.parse(msg.Body);
  await cache.receiveCrossRegionInvalidation(event);
});
```

### Invalidation Loop Prevention & Deduplication
* **Origin Checking**: If `event.originRegion === this.currentRegion`, the event is dropped immediately.
* **UUID Ring-Buffer**: Tracks the last 10,000 processed event IDs in an in-memory ring buffer, discarding duplicate transmissions without touching the local cache.
* **Local Fan-Out**: When an incoming cross-region event is accepted, it invalidates local L1/disk and broadcasts to the regional Redis backplane so sibling pods update instantly without re-broadcasting back to the cross-region mesh.
