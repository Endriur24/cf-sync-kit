# cf-sync-kit

A real-time synchronization framework for Cloudflare Workers with Durable Objects, Hono, and React. Provides live sync between clients through WebSockets with optimistic updates, type-safe CRUD operations, and multi-tenant isolation.

## Features

- **Real-time sync** via WebSockets (PartySocket) with broadcast ordering
- **Optimistic updates** with authoritative cache recovery on failure (TanStack Query)
- **Type-safe** CRUD operations inferred from Drizzle + Zod schemas
- **Multi-tenant isolation** via syncId scoping
- **Scope filtering** for targeted D1 queries and client cache selection within a `syncId`
- **WebSocket authorization** before Durable Object routing with defense-in-depth connection checks
- **Server-side ordering** via `orderByColumn` & `orderDirection` (defaults to `createdAt` or `id` descending)
- **Middleware system** for auth, logging
- **Health check endpoint** for monitoring (`GET /health`)
- **Request timeout** (10s) with structured `TIMEOUT_ERROR` handling
- **Runtime validation** for mutually exclusive config options
- **Debug mode** for development

## Quick Start (Standalone)

For the fastest way to get started, clone the standalone todo example that uses `cf-sync-kit` installed from npm:

```bash
git clone https://github.com/Endriur24/cf-sync-kit-todo-example.git
cd cf-sync-kit-todo-example
npm install
npm run cf-typegen
npm run db:setup:local
npm run dev
```

This is a self-contained starter project demonstrating CRUD, live sync, connection status, and multiple collections with `singleTenant: true`.

## Try the Examples

Clone the repository and run one of the included example apps to see cf-sync-kit in action:

```bash
git clone https://github.com/Endriur24/cf-sync-kit.git
cd cf-sync-kit
npm install
```

Then pick an example that matches your use case:

```bash
cd example/todo-app          # Basic single-tenant app (no syncId column)
# cd example/scoped-todos-app  # Single-tenant with scope-filtered queries and client caches
# cd example/auth-todo-app     # Per-user auth with user-scoped todos
# cd example/project-roles-todo-app  # Project-based role permissions
# cd example/bulk-todo         # Bulk operations demo
```

Inside the example directory, set up the local database and start the dev server:

```bash
npm install              # Install example-specific dependencies
npm run db:setup:local   # Generate and apply D1 migrations locally
npm run dev              # Start the dev server (Vite + Wrangler)
```

The first `npm run dev` will launch Vite (frontend) and Wrangler (Worker + D1 + Durable Object) with hot-reload enabled.

## Installation

```bash
npm install cf-sync-kit
```

**Peer dependencies** (install what your app uses):

```bash
npm install hono @hono/zod-validator drizzle-orm drizzle-zod zod
npm install partyserver partysocket
npm install react react-dom @tanstack/react-query
```

## Quick Start

### 1. Define your schema

```ts
// shared/schema.ts
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'
import { createInsertSchema, createSelectSchema } from 'drizzle-zod'
import { defineCollections } from 'cf-sync-kit'

export const todosTable = sqliteTable('todos', {
  id: text('id').primaryKey(),
  project_id: text('project_id').notNull(),  // any column name you want
  title: text('title').notNull(),
  completed: integer('completed', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})

export const collectionsConfig = defineCollections({
  todos: {
    table: todosTable,
    syncIdColumn: 'project_id',  // tells framework which column is the sync/tenant ID
    insertSchema: createInsertSchema(todosTable).omit({ id: true, createdAt: true, updatedAt: true, project_id: true }),
    updateSchema: createInsertSchema(todosTable).omit({ id: true, project_id: true, createdAt: true, updatedAt: true }).partial(),
    selectSchema: createSelectSchema(todosTable),
  },
})
```

No need to define intermediate types like `TodoSelectSchema`, `Todo`, `CollectionName` — the framework infers everything from `collectionsConfig`.

> **Tip:** If your syncId column is named `syncId` (the default), omit it from your insertSchema:
> ```ts
> insertSchema: createInsertSchema(todosTable).omit({ id: true, createdAt: true, updatedAt: true, syncId: true })
> ```

#### syncIdColumn

By default, the framework expects a column named `syncId`. Use `syncIdColumn` to specify any column name (e.g. `project_id`, `tenant_id`, `user_id`). The syncId value is automatically injected by the backend on insert — omit it from your `insertSchema`.

```ts
// Per-user model
syncIdColumn: 'user_id',
ownerColumn: 'user_id'

// Per-project model
syncIdColumn: 'project_id'

// Per-tenant model
syncIdColumn: 'tenant_id'
```

#### scopeColumn

By default, scope filtering looks for a column named `scope`. Use `scopeColumn` in collection config or router options to specify a custom column name (e.g. `list_id`, `category_id`). Initial `GET` requests append `?scope=...` to execute targeted SQL queries in Cloudflare D1 (`WHERE scope = ?`), preventing full table reads and saving D1 Read Units.

```ts
// Custom scope column name
scopeColumn: 'list_id'
```

`scope` is a query and client-cache filter, not an authorization boundary. Every authorized WebSocket connected to the same `syncId` receives the room's broadcast frames, including their payloads. Use a different `syncId` whenever data must not be visible to another client.

#### ownerColumn

If ownership is stored under a name other than `ownerId`, configure `ownerColumn`. The router uses it for server-side ownership injection, Repository protects it from client mutation, and the `per-user` Durable Object preset verifies the same field. The preset fails fast if that column is missing from the Drizzle table:

```ts
ownerColumn: 'created_by'
```

#### orderByColumn & orderDirection

By default, `GET` queries and `Repository.findAll` sort results by `createdAt` (if present in the table schema) or `id` in descending order (`desc` - newest first). You can customize the sorting column and direction in collection config:

```ts
export const collectionsConfig = defineCollections({
  todos: {
    table: todosTable,
    orderByColumn: 'title',   // Column to order by
    orderDirection: 'asc',    // 'asc' or 'desc' (default: 'desc')
    insertSchema: ...,
    updateSchema: ...,
    selectSchema: ...,
  },
})
```

#### Single-Tenant Mode

For simple applications where all data is shared (no multi-tenant isolation needed), use `singleTenant: true`. This removes the need for a syncId column in your schema and makes `syncId` optional in client hooks.

```ts
// Single-tenant model — no syncId column needed!
export const todosTable = sqliteTable('todos', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  completed: integer('completed', { mode: 'boolean' }).notNull().default(false),
})

export const collectionsConfig = {
  todos: {
    table: todosTable,
    insertSchema: createInsertSchema(todosTable).omit({ id: true }),
    updateSchema: createInsertSchema(todosTable).omit({ id: true }).partial(),
    selectSchema: createSelectSchema(todosTable),
    singleTenant: true,  // ← enables single-tenant mode
  },
}
```

Client usage becomes simpler — no syncId needed:

```tsx
// Single-tenant (simplified)
useLiveSync()
useCollection('todos')

// Multi-tenant (full)
useLiveSync('my-project')
useCollection('todos', 'my-project')
```

> **Note:** `singleTenant` and `syncIdColumn` are mutually exclusive. Use `singleTenant` for shared data, or `syncIdColumn` for isolated data.
> **Runtime validation:** `defineCollections()` will throw an error if you accidentally set both options on the same collection.

#### autoTimestamp

By default, the Repository automatically sets `createdAt` and `updatedAt` on `create`/`bulkCreate`, and `updatedAt` on `update`/`bulkUpdate`. If your schema manages timestamps manually, disable this with `autoTimestamp: false`:

```ts
export const collectionsConfig = defineCollections({
  todos: {
    table: todosTable,
    autoTimestamp: false,  // ← disable automatic timestamp injection
    insertSchema: ...,
    updateSchema: ...,
    selectSchema: ...,
  },
})
```

#### Soft Delete

Enable soft-delete to preserve records in the database while hiding them from the application. When enabled, `delete` and `bulk-delete` operations perform an `UPDATE` that sets a timestamp column instead of physically removing rows. The client still receives `action: 'delete'` broadcast events — no frontend changes needed.

```ts
// 1. Add a timestamp column to your schema
export const todosTable = sqliteTable('todos', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),  // ← nullable soft-delete column
})

// 2. Enable soft-delete in collection config
export const collectionsConfig = defineCollections({
  todos: {
    table: todosTable,
    insertSchema: createInsertSchema(todosTable).omit({ id: true, createdAt: true, updatedAt: true }),
    updateSchema: createInsertSchema(todosTable).omit({ id: true }).partial(),
    selectSchema: createSelectSchema(todosTable),
    softDeleteColumn: true,  // ← uses "deletedAt" as the default column name
  },
})
```

**How it works:**

| Operation | Without soft-delete | With soft-delete |
|-----------|--------------------|------------------|
| `delete` | `DELETE FROM table` | `UPDATE table SET deletedAt = NOW()` |
| `bulk-delete` | `DELETE FROM table WHERE id IN (...)` | `UPDATE table SET deletedAt = NOW() WHERE id IN (...)` |
| `findAll` / `GET` | Returns all rows | Filters `WHERE deletedAt IS NULL` |
| Client broadcast | `action: 'delete'` | `action: 'delete'` (unchanged) |

**Configuration options:**

```ts
// Use default column name "deletedAt"
softDeleteColumn: true

// Use a custom column name
softDeleteColumn: 'archived_at'
```

> **Note:** Soft-deleted records are automatically excluded from `findAll` and the `GET /:syncId/:collection` REST endpoint. The client UI receives standard `delete` events and removes items from cache — no code changes required on the frontend.

### 2. Create your Durable Object

```ts
// server/do.ts
import { createDurableObject, createGetRoomFn } from 'cf-sync-kit/server'
import { collectionsConfig } from '../shared/schema'

// Per-user model — one-liner with preset!
export const { SyncRoom: UserRoom } = createDurableObject(collectionsConfig, {
  className: 'UserRoom',
  preset: 'per-user'
})

export function getRoom(env: Bindings, syncId: string) {
  return createGetRoomFn(env.USER_ROOM as DurableObjectNamespace<InstanceType<typeof UserRoom>>)(env, syncId)
}
```

Completed mutation receipts make retries with the same `_clientMutationId` idempotent. They are retained for 24 hours, with at most 512 entries per room. Both limits can be adjusted without using the room's Durable Object alarm:

```ts
export const { SyncRoom: UserRoom } = createDurableObject(collectionsConfig, {
  className: 'UserRoom',
  preset: 'per-user',
  mutationReceipts: {
    ttlMs: 6 * 60 * 60 * 1000,
    maxEntries: 1_000,
  },
})
```

Expired and oldest receipts are pruned during subsequent mutations. Retrying after the configured retention window is a new operation, so choose a window longer than the maximum client retry period.

> **⚠️ `preset: 'per-user'` requirements:**
>
> | Requirement | Detail |
> |---|---|
> | **syncId format** | Must match the authenticated `userId` exactly. If not → **403 Forbidden** on every mutation |
> | **Table columns** | Must have the configured `syncIdColumn` and `ownerColumn`. They may point to the same property (e.g. `owner_id`). Missing ownership configuration fails fast during setup |
> | **Data model** | Each user has isolated data — no sharing between users |
> | **WebSocket routing** | Use `createWebSocketHandler` with an authorizer that returns the verified user ID. The preset checks that it equals the room `syncId` |
>
> **Do NOT use this preset** if multiple users share a `syncId` room (projects, teams). Use custom middleware and a matching WebSocket authorizer instead.

#### Custom Database Binding Name

By default, the framework expects your D1 database binding to be named `DB`. If your `wrangler.jsonc` uses a different binding name, specify it via `dbName`:

```ts
// wrangler.jsonc
{
  "d1_databases": [
    { "binding": "TODOS_DB", "database_name": "my-db", "database_id": "..." }
  ]
}

// server/do.ts
export const { SyncRoom: ProjectRoom } = createDurableObject(collectionsConfig, {
  className: 'ProjectRoom',
  dbName: 'TODOS_DB'  // ← custom binding name
})

// server/api.ts
const syncApi = createSyncApi(collectionsConfig, getRoom, {
  dbName: 'TODOS_DB'  // ← also pass it to the router
})
```

> **See:** `example/todo-app` for a working example with a custom `TODOS_DB` binding name.

Need custom middleware? Extend manually:

```ts
// Shared model with custom middleware
export const { SyncRoom: ProjectRoom } = createDurableObject(collectionsConfig, {
  className: 'ProjectRoom',
  middleware: [
    requireAuth(),
    injectProjectAccessMiddleware(),
    createCollectionAccessMiddleware({ ... }),
  ]
})
```

Or mix preset with custom middleware (custom runs AFTER preset middleware):

```ts
export const { SyncRoom: UserRoom } = createDurableObject(collectionsConfig, {
  className: 'UserRoom',
  preset: 'per-user',
  middleware: [
    createLoggingMiddleware(),
  ]
})
```

Or extend fully from base classes:

```ts
import { DurableObjectBase, Repository } from 'cf-sync-kit/server'

export class ProjectRoom extends DurableObjectBase {
  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env)
    Object.entries(collectionsConfig).forEach(([name, config]) => {
      this.registerRepository(
        new Repository(env.DB, config.table, name, config.syncIdColumn ?? 'syncId')
      )
    })
  }
}
```

### 3. Set up the API

```ts
// server/api.ts
import { Hono } from 'hono'
import { createSyncApi } from 'cf-sync-kit/server'
import { collectionsConfig } from '../shared/schema'
import { getRoom } from './do'

const app = new Hono<{ Bindings: Bindings }>()
const syncApi = createSyncApi(collectionsConfig, getRoom)

app.route('/api', syncApi)

// Health check endpoint is automatically available at /api/health
// Returns: { status: 'ok', timestamp: '...', collections: ['todos', ...] }

export default app
```

### REST Endpoints

`createSyncApi` exposes all collections under a single tenant prefix:

**Multi-tenant** (`syncId` from your app, e.g. `my-project`):
```
GET    /api/:syncId/:collection
POST   /api/:syncId/:collection
PUT    /api/:syncId/:collection/:id
DELETE /api/:syncId/:collection/:id
POST   /api/:syncId/:collection/bulk
PUT    /api/:syncId/:collection/bulk
DELETE /api/:syncId/:collection/bulk
```

**Single-tenant** (`singleTenant: true`) uses the literal `default` tenant:
```
GET    /api/default/:collection
POST   /api/default/:collection
PUT    /api/default/:collection/:id
DELETE /api/default/:collection/:id
POST   /api/default/:collection/bulk
PUT    /api/default/:collection/bulk
DELETE /api/default/:collection/bulk
```

The client hooks (`useCollection`, `useLiveSync`) automatically use the correct URLs. For single-tenant apps you can omit `syncId` entirely — it defaults to `'default'`.

### 4. Use in your React app

```tsx
// client/app.tsx
import { ConnectionProvider, useCollection, useLiveSync } from 'cf-sync-kit'
import { collectionsConfig } from './shared/schema'

function App() {
  return (
    <ConnectionProvider>
      <TodoList />
    </ConnectionProvider>
  )
}

function TodoList() {
  useLiveSync('my-project', { debug: true })
  // Types are inferred from collectionsConfig via the collection name!
  const { data, add, update, remove, isLoading } = useCollection('todos', 'my-project')

  if (isLoading) return <div>Loading...</div>

  return (
    <div>
      {data.map(todo => (
        <div key={todo.id}>
          <input
            type="checkbox"
            checked={todo.completed}
            onChange={() => update({ id: todo.id, data: { completed: !todo.completed } })}
          />
          {todo.title}
          <button onClick={() => remove(todo.id)}>Delete</button>
        </div>
      ))}
      <button onClick={() => add({ title: 'New todo' })}>Add</button>
    </div>
  )
}
```

## API Reference

### Client (`cf-sync-kit`)

| Export | Description |
|--------|-------------|
| `ConnectionProvider` | React provider for WebSocket connection state |
| `useConnectionStatus()` | Returns aggregate and per-room status, including `isConnected`, `isConnecting`, `isReconnecting`, `isSynchronizing`, `isDegraded`, and `isDisconnected` |
| `useCollection<C, K>(...)` | Generic CRUD hook — types inferred from collection name |
| `useLiveSync(syncId, options?)` | WebSocket sync hook with broadcast handling |
| `defineCollections(config)` | Type-safe config helper — alternative to `as const` |
| `UseCollectionOptions` | Options interface for useCollection |
| `UseCollectionResult` | Return type of useCollection hook |

#### Events (`cf-sync-kit`)

| Export | Description |
|--------|-------------|
| `WsEventSchema` | Zod schema for validating WebSocket messages |
| `WsBroadcastEvent` | Type for broadcast events after mutations |
| `WsSyncInitEvent` | Type for sync-init event on WebSocket connect |
| `WsEvent` | Union type of all WebSocket events |

#### useCollection Options

```ts
interface UseCollectionOptions {
  apiPrefix?: string          // Default: '/api'
  debug?: boolean             // Enable debug logging
  /**
   * Refetch data from server after a successful mutation.
   * Default: false — optimistic updates + broadcast are usually enough.
   * Set to true only if you need extra certainty (large datasets, heavy middleware, etc.).
   */
  refetchOnSuccess?: boolean
  /**
   * Route GET requests through the Durable Object instead of direct D1 read.
   * Ensures strong consistency after DO hibernation.
   */
  consistentReads?: boolean
  /**
   * Custom headers to include in API requests (e.g. Authorization).
   */
  headers?: Record<string, string> | (() => Record<string, string>)
  /**
   * Enable optimistic UI updates. When false, cache is only updated after
   * the server responds (pessimistic mode).
   * Default: true
   */
  optimisticUpdates?: boolean
  /**
   * Move updated items to the top of the collection list in client cache.
   * Default: false (items retain their existing array position)
   */
  reorderOnUpdate?: boolean
}
```

Mutations automatically retry on 5xx, 429, and network errors with exponential backoff (max 10s). All requests have a 10-second timeout — if the server doesn't respond within this time, a `TIMEOUT_ERROR` is thrown.

By default, mutations do **not** refetch from the server after success — optimistic updates combined with broadcast sync keep the cache accurate. Set `refetchOnSuccess: true` if you need extra certainty (e.g. custom server middleware that modifies data).

Note: `refetchOnSuccess` can be used together with `consistentReads: true` for maximum consistency guarantees.

#### Optimistic vs Pessimistic Updates

By default, all mutations are **optimistic** — the UI updates immediately before the server responds, providing instant feedback. If the server rejects the mutation, the affected query is invalidated and refetched from the authoritative server state. This avoids restoring a stale whole-cache snapshot over another mutation that completed concurrently.

For critical operations where you want to wait for server confirmation before showing changes to the user, use pessimistic mode:

```tsx
// Pessimistic: UI only updates after server confirms
const { data, update, isUpdating } = useCollection('todos', syncId, undefined, {
  optimisticUpdates: false
})

// Optimistic (default): UI updates instantly, refetches authoritative state on error
const { data, update, isUpdating } = useCollection('todos', syncId)
```

Use `isUpdating`, `isAdding`, `isRemoving` flags to show loading spinners in pessimistic mode:

```tsx
<button onClick={() => update({ id: todo.id, data: { completed: !todo.completed } })} disabled={isUpdating}>
  {isUpdating ? 'Saving...' : 'Toggle'}
</button>
```

#### Error Handling

Each mutation operation returns a dedicated error state that you can display in the UI:

```tsx
const { 
  add, addError, isAdding,
  update, updateError, isUpdating,
  remove, removeError, isRemoving
} = useCollection('todos', syncId)

return (
  <div>
    <button onClick={() => update({ id: todo.id, data: { title: 'New' } })}>
      Save
    </button>
    {updateError && (
      <div className="text-red-500">
        Save error: {updateError.message}
      </div>
    )}
  </div>
)
```

For bulk operations, similarly: `addManyError`, `updateManyError`, `removeManyError`.

**Structured error handling:**

All API errors are thrown as `SyncError` instances with `code`, `status`, and `details` properties:

```ts
import { isSyncError } from 'cf-sync-kit'

try {
  add({ title: 'New todo' })
} catch (err) {
  if (isSyncError(err)) {
    switch (err.code) {
      case 'API_ERROR':
        console.error(`HTTP ${err.status}: ${err.message}`)
        break
      case 'TIMEOUT_ERROR':
        console.error('Request timed out after 10s')
        break
      case 'NETWORK_ERROR':
        console.error('Network error — check connection')
        break
      default:
        console.error(`Unknown error: ${err.message}`)
    }
  }
}
```

#### Bulk Operations (Phase 1)

```tsx
const { addMany, updateMany, removeMany } = useCollection('todos', syncId)

// Add multiple items at once
addMany([{ title: 'A' }, { title: 'B' }])

// Update multiple items
updateMany([
  { id: '1', data: { completed: true } },
  { id: '2', data: { completed: false } }
])

// Remove multiple items
removeMany(['1', '2'])
```

Bulk operations work with the same optimistic updates and retry logic as single operations. They also expose their own loading and error states:

```tsx
const { 
  addMany, isAddingMany, addManyError,
  updateMany, isUpdatingMany, updateManyError,
  removeMany, isRemovingMany, removeManyError
} = useCollection('todos', syncId)
```

**Limits:** `addMany` and `updateMany` accept max 100 items per request. `removeMany` accepts max 100 IDs. All items are validated against your Zod schemas on the server.

**Error handling:** All API errors are thrown as `SyncError` instances with `code`, `status`, and `details` properties for structured error handling:

```ts
import { isSyncError } from 'cf-sync-kit'

try {
  addMany(items)
} catch (err) {
  if (isSyncError(err)) {
    console.error(`[${err.code}] ${err.message}`)
  }
}
```

Invalid request bodies return HTTP 400 with `code: 'VALIDATION_ERROR'` and structured `issues`. Reusing an entity ID that belongs outside the active `syncId` boundary returns HTTP 409 without returning the conflicting record.

#### consistentReads Option

Enable consistent reads to route GET requests through the Durable Object instead of D1:

```ts
useCollection('todos', syncId, undefined, { consistentReads: true })
```

You can also enable it per-request by appending `?consistent=true` to the URL. This ensures consistency with broadcast counters after hibernation.

#### useLiveSync Options

```ts
interface UseLiveSyncOptions {
  scope?: string              // Deprecated; cache routing uses each event's scope
  party?: string              // PartyKit party/namespace (default: 'main')
  debug?: boolean             // Enable debug logging
  onError?: (error: Error) => void  // Error callback
  query?: Record<string, string> | (() => Record<string, string>)  // URL query params for auth tokens
  heartbeatInterval?: number  // Liveness probe cadence in ms (default: 20000; 0 disables it)
  heartbeatTimeout?: number   // Wait for pong before reconnecting, in ms (default: 10000)
}
```

`useLiveSync` sends an application-level `ping` on the configured interval. The
included `DurableObjectBase` answers with `pong` at the Cloudflare edge, including
while hibernated. A missing pong forces PartySocket to reconnect, preventing a
browser from retaining a half-open (zombie) WebSocket for minutes.

`useConnectionStatus()` retains its aggregate `status`; it is `connected` only
when every active `syncId` has completed its recovery refetch. Its `roomStatuses`
property exposes the individual status for each room. During the automatic
connection lifecycle, statuses are `connecting`, `reconnecting`,
`synchronizing`, `connected`, and `degraded`. The hook keeps retrying after a
transport failure, so it does not emit `disconnected`; that value remains in
`ConnectionStatus` for compatibility and explicit application-level status
management. When a tab becomes visible again, returns from the back/forward
cache, or receives the browser's `online` hint, the hook immediately probes the
socket and refetches its scoped queries before returning to `connected`.

### Server (`cf-sync-kit/server`)

| Export | Description |
|--------|-------------|
| `createDurableObject(config, opts)` | **Factory** — creates DO class with auto-registered repos. Supports `preset: 'per-user'` and bounded `mutationReceipts` retention |
| `createGetRoomFn(namespace)` | **Factory** — creates typed room resolver |
| `createWebSocketHandler(namespace, options)` | Routes WebSocket upgrades with an explicit `authorize` callback or `{ public: true }` |
| `requireWebSocketUser(getUserId)` | Per-user WebSocket authorizer requiring `userId === syncId` |
| `DurableObjectBase` | Base class for custom Durable Objects |
| `Repository` | CRUD operations for a Drizzle table |
| `createSyncApi(collections, getRoom, options?)` | Creates Hono app with `/:syncId/:collection` sync endpoints |
| `MiddlewareSystem` | Middleware chain manager |
| `createAuthMiddleware(getUserId)` | Authentication middleware |
| `createLoggingMiddleware()` | Mutation logging |
| `requireAuth()` | Requires `ctx.userId` to be set |
| `requireOwner(options?)` | Requires record owner matches `ctx.userId` |
| `createSyncAccessMiddleware(validate)` | Custom syncId access validation |
| `createDefaultSyncAccessValidator(prefix?)` | Helper for per-user syncId validation (default: exact match) |
| `createCollectionAccessMiddleware(rules)` | Granular action-specific collection access control |
| `CustomAccess` | Interface for custom access context (extend via module augmentation) |
| `BroadcastSystem` | Manages broadcast counters and event distribution |
| `MiddlewareContext` | Context object passed to middleware functions |
| `Middleware` | Middleware function type |
| `RoomMutator` | Interface for DO room mutation methods |
| `GetRoomFn` | Type for room resolver function |
| `CollectionRouterOptions` | Options for `createSyncApi` (including `dbName`, `ownerColumn`, and access validation) |
| `WebSocketHandlerOptions` | WebSocket route options, including party restriction and explicit access mode |

### Shared Types

| Type | Description |
|------|-------------|
| `ActionType` | `'insert' \| 'update' \| 'delete' \| 'bulk-insert' \| 'bulk-update' \| 'bulk-delete'` |
| `CollectionConfig` | Config for a collection (table, schemas, syncIdColumn, scopeColumn, singleTenant, orderByColumn, orderDirection, reorderOnUpdate) |
| `CollectionsMap` | Map of collection names to configs |
| `InferInsert<C, K>` | Infer insert type from collection config |
| `InferUpdate<C, K>` | Infer update type from collection config |
| `InferEntity<C, K>` | Infer entity type from collection config |
| `PendingMutationInfo` | Tracks pending optimistic mutations |
| `ConnectionStatus` | `'connecting' \| 'reconnecting' \| 'synchronizing' \| 'connected' \| 'degraded' \| 'disconnected'` |
| `SyncError` | Custom error class with code, status, and details |
| `isSyncError(err)` | Type guard to check if error is a SyncError |
| `defineCollections(config)` | Type-safe config helper |

## Authorization

cf-sync-kit supports three authorization layers with **server-side ownership injection**: HTTP reads/writes, mutation defense inside the Durable Object, and WebSocket broadcast subscriptions.

### Security Principle

**Never trust client-provided ownership fields.** The `ownerId` is injected by the backend on insert, ensuring users cannot impersonate others.

### 1. Router Layer (HTTP requests)

Validates access before any HTTP request reaches the Durable Object:

```ts
// server/api.ts
import { createSyncApi, createDefaultSyncAccessValidator } from 'cf-sync-kit/server'

const syncApi = createSyncApi(collectionsConfig, getRoom, {
  // Extract user ID from Hono context (set by your auth middleware)
  getUserId: (c) => c.get('userId'),
  // Validate user can only access their own sync scope
  // Default: syncId must equal userId exactly. Pass a prefix (e.g. 'user:') if needed.
  validateSyncAccess: createDefaultSyncAccessValidator(),
})
```

On insert, the router automatically injects the configured `ownerColumn = userId` into the payload.

### 2. Durable Object Layer (mutations)

Validates access inside the Durable Object before mutations are executed:

```ts
// server/do.ts
import { createDurableObject, requireAuth, createSyncAccessMiddleware, requireOwner, createDefaultSyncAccessValidator } from 'cf-sync-kit/server'

export const { SyncRoom: ProjectRoom } = createDurableObject(collectionsConfig, {
  className: 'ProjectRoom',
  middleware: [
    requireAuth(),                                    // Must have userId
    createSyncAccessMiddleware(                       // Must own the sync scope
      createDefaultSyncAccessValidator()              // syncId must equal userId
    ),
    requireOwner({ checkOnUpdateDelete: false }),     // Verify ownerId on insert only
  ],
})
```

### How ownership works

| Action | Owner handling |
|--------|----------------|
| **Insert** | Backend injects `ownerColumn = ctx.userId` and `syncIdColumn = syncId` — client cannot override |
| **Update** | Ownership enforced by syncId isolation (`createSyncAccessMiddleware`) |
| **Delete** | Ownership enforced by syncId isolation (`createSyncAccessMiddleware`) |

### Why separate layers?

| Layer | Protects | When it runs |
|-------|----------|--------------|
| Router | GET, POST, PUT, DELETE | Before reaching DO |
| DO Middleware | Mutations only | Inside DO, before DB write |
| WebSocket handler | Broadcast subscription | Before upgrade routing to DO |

The router layer prevents unauthorized reads. The DO layer provides defense-in-depth for mutations (useful if you have other entry points to the DO).

### 3. WebSocket layer (broadcast reads)

`validateSyncAccess` protects HTTP endpoints only. WebSocket upgrades must be authorized separately, otherwise anyone who knows a `syncId` can subscribe to that room's broadcasts.

```ts
import { createWebSocketHandler, requireWebSocketUser } from 'cf-sync-kit/server'

app.all('/parties/:party/:roomId', (c) =>
  createWebSocketHandler(c.env.PROJECT_ROOM, {
    party: 'todos',
    authorize: requireWebSocketUser(async () => c.get('userId')),
  })(c.req.raw)
)
```

The handler removes client-supplied internal identity headers, authorizes before invoking the Durable Object, and forwards only the verified identity. The `per-user` Durable Object preset verifies that identity again and requires it to equal the room `syncId`. For intentionally public rooms use `{ public: true }` explicitly.

### Shared sync IDs

For shared rooms where multiple users access the same `syncId`, apply the same membership rule to HTTP, Durable Object mutations, and WebSocket upgrades:

```ts
// Router layer
validateSyncAccess: async (userId, syncId) => {
  const team = await db.query.teams.findFirst({
    where: { id: syncId, members: { contains: userId } }
  })
  if (!team) throw new Error('Forbidden')
}

// DO layer
createSyncAccessMiddleware(async (userId, syncId) => {
  // Same logic as above
})

// WebSocket layer
createWebSocketHandler(env.PROJECT_ROOM, {
  authorize: async ({ request, syncId }) => {
    const userId = await authenticate(request)
    if (!await canAccessTeam(userId, syncId)) {
      return new Response('Forbidden', { status: 403 })
    }
    return userId
  },
})
```

### Built-in middleware

| Middleware | Purpose |
|------------|---------|
| `requireAuth()` | Throws if `ctx.userId` is not set |
| `requireOwner(options?)` | Ensures the configured ownership field in payload matches `ctx.userId` |
| `createSyncAccessMiddleware(validate)` | Custom syncId validation |
| `createDefaultSyncAccessValidator(prefix?)` | Helper for per-user syncId validation (default: exact match) |
| `createAuthMiddleware(getUserId)` | Auth inside DO (extracts userId from context) |
| `createLoggingMiddleware()` | Logs mutations for debugging |

#### requireOwner Options

```ts
interface RequireOwnerOptions {
  checkOnUpdateDelete?: boolean  // Check ownership on update/delete (default: false)
  ownerColumn?: string | ((collection: string) => string) // Default: 'ownerId'
  ownerField?: string            // Deprecated alias retained for compatibility
  ownerCheckQuery?: (ctx) => Promise<boolean>  // Custom async ownership check
}

// Per-user model — no update/delete check needed (syncId isolation is enough)
requireOwner()

// Shared scope model — verify ownership with custom DB query
requireOwner({
  checkOnUpdateDelete: true,
  ownerCheckQuery: async (ctx) => {
    const db = drizzle(ctx.env.DB)
    const record = await db.select().from(todos).where(eq(todos.id, ctx.payload.id)).get()
    return record?.ownerId === ctx.userId
  }
})

// Custom owner field name
requireOwner({ ownerColumn: 'createdBy' })
```

## Advanced Authorization – Granular Collection Access Control

cf-sync-kit is intentionally minimal when it comes to business authorization. It doesn't provide built-in roles (`viewer`/`editor`/`owner`) or domain logic. Instead, it gives you a flexible, declarative tool for precise access control at the collection and action level.

### `createCollectionAccessMiddleware`

Allows you to define access rules separately for each action (`insert`, `update`, `delete`, `bulk-*`, etc.).

```ts
import { createCollectionAccessMiddleware } from 'cf-sync-kit/server'

this.use(createCollectionAccessMiddleware({
  photos: {
    insert: true,                                      // any logged-in user can add
    update: (ctx) => ctx.access?.role !== 'viewer',    // viewer cannot edit
    delete: (ctx) => ['owner', 'admin'].includes(ctx.access?.role),
    'bulk-delete': (ctx) => ctx.access?.role === 'owner', // only owner can bulk delete
    '*': true                                          // fallback for read and other actions
  },

  selectionBuckets: {
    insert: true,
    update: true,
    delete: (ctx) => ctx.access?.role === 'owner',
    '*': true
  },

  // Default policy for all remaining collections
  '*': {
    '*': true  // fallback for all actions
  }
}))
```

#### Supported action keys

- `insert`, `update`, `delete`
- `bulk-insert`, `bulk-update`, `bulk-delete`
- `*` – wildcard (acts as a fallback for all actions)

Each rule can be:
- `true` → always allowed
- `false` → always denied
- `(ctx: MiddlewareContext) => boolean | Promise<boolean>` → dynamic logic

### How to inject the `access` context

It is recommended to inject user authorization information **before** `createCollectionAccessMiddleware`:

```ts
this.use(async (ctx, next) => {
  const projectAccess = await getProjectAccess(ctx.userId!, ctx.syncId)
  
  ctx.access = {
    role: projectAccess.role,           // e.g. 'owner' | 'editor' | 'viewer'
    projectId: projectAccess.id,
    // you can add any other data
  }

  await next()
})
```

The `access` field is typed as `CustomAccess`. For full type safety with autocompletion, use module augmentation:

```ts
// In your app's server/middleware.ts
declare module 'cf-sync-kit/server' {
  interface CustomAccess {
    role: 'owner' | 'editor' | 'viewer'
    projectId: string
    projectName?: string
  }
}
```

From now on, `ctx.access?.role` will be fully typed with autocompletion.

#### Example: `injectProjectAccessMiddleware` helper

Create a reusable middleware helper to inject project access context:

```ts
// server/middleware/injectProjectAccess.ts
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import { projects, projectMembers } from '../schema'

export function injectProjectAccessMiddleware() {
  return async (ctx: any, next: () => Promise<void>) => {
    const db = drizzle(ctx.env.DB)
    
    // Fetch project and user's membership
    const project = await db.query.projects.findFirst({
      where: eq(projects.id, ctx.syncId),
      with: {
        members: {
          where: eq(projectMembers.userId, ctx.userId),
        }
      }
    })
    
    if (!project) {
      throw new Error('Project not found')
    }
    
    const membership = project.members[0]
    if (!membership) {
      throw new Error('Access denied')
    }
    
    // Inject access context for downstream middleware
    ctx.access = {
      role: membership.role,            // 'owner' | 'editor' | 'viewer'
      projectId: project.id,
      projectName: project.name,
    }
    
    await next()
  }
}
```

Usage in your Durable Object:

```ts
import { injectProjectAccessMiddleware } from './middleware/injectProjectAccess'

export const { SyncRoom: ProjectRoom } = createDurableObject(collectionsConfig, {
  className: 'ProjectRoom',
  middleware: [
    requireAuth(),
    createSyncAccessMiddleware(...),
    injectProjectAccessMiddleware(),  // Injects ctx.access
    createCollectionAccessMiddleware({
      photos: {
        insert: true,
        update: (ctx) => ctx.access?.role !== 'viewer',
        delete: (ctx) => ['owner', 'admin'].includes(ctx.access?.role),
        '*': true
      },
    }),
  ]
})
```

### Full example in a Durable Object

```ts
export const { SyncRoom: ProjectRoom } = createDurableObject(collectionsConfig, {
  className: 'ProjectRoom',
  middleware: [
    requireAuth(),
    createSyncAccessMiddleware(...),
    
    // Inject access context
    injectProjectAccessMiddleware(),
    
    // Granular rules per collection and action
    createCollectionAccessMiddleware({
      photos: {
        insert: true,
        update: (ctx) => ctx.access?.role !== 'viewer',
        delete: (ctx) => ['owner', 'admin'].includes(ctx.access?.role),
        'bulk-delete': (ctx) => ctx.access?.role === 'owner',
        '*': true
      },
      // ...
    }),

    requireOwner({ checkOnUpdateDelete: true })
  ]
})
```

## Middleware Examples

```ts
// Auth: extract user from request
this.use(createAuthMiddleware(async (ctx) => {
  const token = getRequestHeader('Authorization')
  return await verifyToken(token)
}))

// Collection access control (whitelist collections, all actions allowed)
this.use(createCollectionAccessMiddleware({
  todos: { '*': true },
  notes: { '*': true },
}))

// Logging
this.use(createLoggingMiddleware())

// Custom middleware
this.use(async (ctx, next) => {
  if (ctx.action === 'delete' && !ctx.userId) {
    throw new Error('Must be logged in to delete')
  }
  await next()
})
```

## Consistent Reads

By default, `GET /:syncId/:collection` reads directly from D1 for performance. This can cause eventual consistency issues after Durable Object hibernation. Enable `consistentReads` to route reads through the DO:

```ts
const syncApi = createSyncApi(collectionsConfig, getRoom, {
  consistentReads: true,
})
```

| Mode | Pros | Cons |
|------|------|------|
| `consistentReads: false` (default) | Faster, doesn't wake DO | Possible read-after-write lag |
| `consistentReads: true` | Strong consistency with broadcasts | Wakes DO on every read |

## Scope Feature

Scopes allow multiple logical sub-groups (e.g. todo lists, channels, categories) to share the same WebSocket connection and Durable Object instance while keeping D1 queries and client caches focused on one subgroup.

When `scope` is specified in `useCollection(collectionName, syncId, scope)`:

1. **Server-Side D1 SQL Filtering**: Initial `GET` requests append `?scope=...` to query parameters. The server executes a targeted SQL query (`WHERE scope = ?`) in Cloudflare D1, returning only records belonging to that scope — saving D1 Read Units and reducing payload size.
2. **Client cache routing**: WebSocket messages carry the `scope` property. A scoped event updates the matching scoped cache and the unscoped cache for the same collection and `syncId`; unrelated scopes and other rooms remain unchanged. Gap and reconnect recovery refetch all affected caches because sequence counters are shared by the collection.

```ts
// Client: each list / subpage fetches only its targeted scope data
useLiveSync()
useCollection('scopedTodos', undefined, listIdA) // GET /default/scopedTodos?scope=listIdA
useCollection('scopedTodos', undefined, listIdB) // GET /default/scopedTodos?scope=listIdB
```

> **Tip:** When using scopes with foreign keys (e.g. `scope` references `lists.id`), use the raw ID as the scope value — not a prefixed string. This ensures the FK constraint is satisfied. You can customize the column name using `scopeColumn` in collection config.

`useLiveSync(..., { scope })` remains accepted for compatibility but no longer filters room broadcasts. Prefer one room-level `useLiveSync(syncId)` call and pass scope only to `useCollection`. This keeps every mounted scoped and unscoped query coherent while `syncId` remains the isolation boundary.

> **Security:** `scope` is not a privacy or authorization boundary. Separate confidential groups into different `syncId` rooms and authorize both their HTTP requests and WebSocket upgrades.

## Performance & Consistency Trade-offs

See [Consistent Reads](#consistent-reads) above for read consistency trade-offs.

### Mutation Refetch

After a successful mutation, the cache is updated optimistically and then confirmed by the broadcast event. By default, no server refetch occurs:

| Mode | Pros | Cons |
|------|------|------|
| `refetchOnSuccess: false` (default) | No extra network calls, fast UX | Relies on optimistic + broadcast accuracy |
| `refetchOnSuccess: true` | Guaranteed server-synced state | Extra HTTP request per mutation |

### Broadcast Ordering & Gap Detection

The framework guarantees ordered application of broadcast events using monotonically increasing `broadcastId` counters per collection:

1. **Sequential ordering**: Each broadcast event gets an incrementing ID. The client tracks the last seen ID per collection.
2. **Gap detection**: If `broadcastId > lastId + 1`, the client detects a gap (e.g., missed messages during reconnect) and automatically triggers a full refetch to restore consistency.
3. **Duplicate rejection**: Events with `broadcastId <= lastId` are silently ignored.

### Stale Overwrite Protection

When applying broadcast updates to the cache, the framework uses `compareUpdatedAt` to prevent stale data from overwriting newer values:

```ts
// If incoming updatedAt is older than existing, keep existing
if (incoming.updatedAt < existing.updatedAt) return existing
return { ...existing, ...incoming }
```

This protects against race conditions where two clients update the same entity simultaneously — the slower broadcast won't overwrite the faster one's newer data.

### Automatic Timestamp Injection

The Repository automatically sets `createdAt` and `updatedAt` on `create`/`bulkCreate`, and `updatedAt` on `update`/`bulkUpdate` operations. You don't need to include these in your payloads — they're added server-side to ensure accurate timestamps for the stale overwrite protection.

### Bulk Operations Partial Failure Behavior

Bulk operations (`addMany`, `updateMany`, `removeMany`) are batched to stay within D1's limit of 100 bound parameters per individual statement:

- **`addMany`**: Uses `INSERT ... VALUES (...), (...), ...` with dynamic batch size (~5-18 items depending on columns). Each batch is a separate query.
- **`updateMany`**: Validates every differently shaped update against the per-statement limit and sends chunks of statements through `db.batch([...])`.
- **`removeMany`**: Reserves parameters for `syncId`, optional scope, and soft-delete values before choosing the `IN (...)` chunk size.

**Partial failure semantics:**
- **If batch 1 succeeds but batch 2 fails**: Batch 1 results are committed. For `updateMany`, the failed batch is fully rolled back (D1 transaction). For `addMany`/`removeMany`, the failed batch is not applied.
- **Client cache**: On failure, the query is invalidated and refetched. A stale snapshot is never restored over concurrently successful mutations.
- **Retry behavior**: A mutation reuses its `_clientMutationId`. Inserts also reuse stable entity IDs, so retrying a partially completed `addMany` does not create duplicate rows. Durable Object receipts return the original result after a completed mutation; after a broadcast failure, retry republishes the stored event with its original sequence ID. Receipts are bounded by the configured TTL and per-room entry limit.

Bulk calls are not atomic across multiple D1 chunks. For operations requiring all-or-nothing semantics across the entire input, implement a domain transaction or dedicated server operation.

## Central Observability

Configure one structured telemetry sink per Worker or browser isolate. Every event includes `schemaVersion: 1`. Framework events never contain mutation payloads or query results; they contain correlation fields such as `collection`, `action`, `syncId`, `mutationId`, `broadcastId`, stage, timings, status, and outcome.

For searchable Cloudflare Workers Logs:

```ts
import { configureObservability } from 'cf-sync-kit/server'

configureObservability({ console: true })
```

For aggregated metrics in Workers Analytics Engine:

```ts
import { env } from 'cloudflare:workers'
import { configureObservability } from 'cf-sync-kit/server'

configureObservability({
  sink: (event) => {
    env.SYNC_ANALYTICS.writeDataPoint({
      indexes: [event.syncId ?? 'global'],
      blobs: [
        event.event,
        event.component,
        event.collection ?? '',
        event.action ?? '',
        event.outcome ?? '',
      ],
      doubles: [
        event.durationMs ?? 0,
        event.queueWaitMs ?? 0,
        event.broadcastId ?? 0,
        event.status ?? 0,
      ],
    })
  },
})
```

The sink is synchronous and best-effort: exceptions are isolated and never fail framework operations. Analytics Engine writes are non-blocking. Do not start network requests inside the sink; use Workers Logs, Analytics Engine, a Tail Worker, or a Queue-backed application adapter instead. If `syncId` or `mutationId` can identify a person or tenant, hash or replace them in your sink before exporting telemetry.

Emitted event families include `mutation.queue.started`, `mutation.sequence.reserved`, `mutation.d1.completed`, `mutation.completed`, `mutation.failed`, `mutation.receipt.replayed`, `mutation.broadcast.retry`, `mutation.broadcast.failed`, `sync.gap.detected`, and `sync.gap.recovered`.

## Running Tests

```bash
npm test          # Run once
npm run test:unit # Node unit/integration tests
npm run test:worker # Real workerd tests with Durable Objects, D1, and WebSockets
npm run test:watch # Watch mode
```

Tests are configured via `vitest.config.ts` with v8 coverage provider. Coverage reports are generated in `coverage/` directory.

## Health Check

The framework automatically exposes a health check endpoint when you use `createSyncApi`:

```
GET /api/health
```

Response:
```json
{
  "status": "ok",
  "timestamp": "2026-04-18T12:00:00.000Z",
  "collections": ["todos", "notes"]
}
```

## Architecture

```
┌─────────────┐  GET (read)       ┌──────────────────────┐
│   React     │ ────────────────► │  Cloudflare Worker   │──────────────────┐
│   Client    │ ◄──────────────── │  (Hono API)          │                  │
│             │                   │  createSyncApi       │                  │ (default)
│ useCollection│  POST/PUT/DELETE │                      │        ┌─────────▼────────┐
│             │ ────────────────► │                      │        │  D1 Database     │
│             │ ◄──────────────── │                      │        │  (SQLite)        │
│             │                   └──────────┬───────────┘        └─────────▲────────┘
│             │                              │ mutate()                     │
│             │                   ┌──────────▼───────────┐                  │
│             │    WebSocket      │  Durable Object      │──────────────────┘
│ useLiveSync │ ◄───────────────► │  (ProjectRoom)       │
│             │                   │                      │
└─────────────┘                   │  BroadcastSystem     │
                                  │  Repository          │
                                  │  MiddlewareSystem    │
                                  └──────────────────────┘
```

- **GET (reads)**: by default go directly from the Worker to D1, bypassing the Durable Object for performance. Enable `consistentReads: true` (or `?consistent=true`) to route reads through the DO instead.
- **Mutations (POST/PUT/DELETE)**: always go through the Worker → DO → D1. The DO then broadcasts the change to all connected WebSocket clients.
- Each `syncId` maps to one Durable Object instance. All clients authorized for the same `syncId` share the DO and can receive its complete broadcast payloads; `scope` filtering on the client does not provide confidentiality.

## Examples

- `example/todo-app` — Basic todo app with single-tenant mode (no syncId column)
- `example/bulk-todo` — Bulk operations
- `example/scoped-todos-app` — Single-tenant app with scope-filtered D1 queries and client caches
- `example/auth-todo-app` — Basic auth with user-scoped todos
- `example/project-roles-todo-app` — Project-based role permissions
