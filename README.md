# cf-sync-kit

A real-time synchronization framework for Cloudflare Workers with Durable Objects, Hono, and React. Provides live sync between clients through WebSockets with optimistic updates, type-safe CRUD operations, and multi-tenant isolation.

## Features

- **Real-time sync** via WebSockets (PartySocket) with broadcast ordering
- **Optimistic updates** with automatic rollback on failure (TanStack Query)
- **Type-safe** CRUD operations inferred from Drizzle + Zod schemas
- **Multi-tenant isolation** via syncId scoping
- **Scope filtering** for shared WebSocket/DO isolation
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
# cd example/scoped-todos-app  # Single-tenant with scope-based broadcast isolation
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
    updateSchema: createInsertSchema(todosTable).omit({ id: true }).partial(),
    selectSchema: createSelectSchema(todosTable),
  },
})
```

No need to define intermediate types like `TodoSelectSchema`, `Todo`, `CollectionName` — the framework infers everything from `collectionsConfig`.

> **Tip:** If your syncId column is named `syncId` (the default), you can omit it explicitly:
> ```ts
> insertSchema: createInsertSchema(todosTable).omit({ id: true, createdAt: true, updatedAt: true, syncId: true })
> ```
> Or use the helper:
> ```ts
> import { omitSyncIdColumn } from 'cf-sync-kit/server'
> insertSchema: omitSyncIdColumn(createInsertSchema(todosTable), 'syncId').omit({ id: true, createdAt: true, updatedAt: true })
> ```

#### syncIdColumn

By default, the framework expects a column named `syncId`. Use `syncIdColumn` to specify any column name (e.g. `project_id`, `tenant_id`, `user_id`). The syncId value is automatically injected by the backend on insert — omit it from your `insertSchema`.

```ts
// Per-user model
syncIdColumn: 'user_id'

// Per-project model
syncIdColumn: 'project_id'

// Per-tenant model
syncIdColumn: 'tenant_id'
```

> **Tip:** You can use `omitSyncIdColumn` helper to automatically omit the syncId column:
> ```ts
> import { omitSyncIdColumn } from 'cf-sync-kit/server'
> 
> insertSchema: omitSyncIdColumn(createInsertSchema(todosTable), 'project_id')
> ```

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

> **⚠️ `preset: 'per-user'` requirements:**
>
> | Requirement | Detail |
> |---|---|
> | **syncId format** | Must match the authenticated `userId` exactly. If not → **403 Forbidden** on every mutation |
> | **Table column** | Must have a sync isolation column (e.g. `owner_id`). Set via `syncIdColumn`. If missing → **DB error** on insert |
> | **Data model** | Each user has isolated data — no sharing between users |
>
> **Do NOT use this preset** if you need shared scopes (projects, teams). Use custom middleware instead.

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

### 4. Create typed hooks (optional but recommended)

```ts
// client/hooks.ts
import { createSyncHooks } from 'cf-sync-kit'
import { collectionsConfig } from '../shared/schema'

export const { useCollection, useUserCollection, useLiveSync, useUserLiveSync } = createSyncHooks(collectionsConfig)
```

`useUserCollection` and `useUserLiveSync` are convenience hooks that use the `userId` directly as the syncId:

```tsx
// Instead of:
useCollection('todos', userId, scope, options)
useLiveSync(userId, { party: 'main' })

// You can write:
useUserCollection('todos', userId, scope, options)
useUserLiveSync(userId, { party: 'main' })
```

### 5. Use in your React app

```tsx
// client/app.tsx
import { ConnectionProvider } from 'cf-sync-kit'
import { useCollection, useLiveSync } from './hooks'

function App() {
  return (
    <ConnectionProvider>
      <TodoList />
    </ConnectionProvider>
  )
}

function TodoList() {
  useLiveSync('my-project', { debug: true })
  // No generics needed — types are inferred from collectionsConfig!
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
| `useConnectionStatus()` | Returns `{ status, isConnected, isConnecting, isDisconnected }` |
| `createSyncHooks(config)` | Factory for pre-typed hooks — **recommended** |
| `useCollection<C, K>(...)` | Generic CRUD hook (use createSyncHooks instead) |
| `useUserCollection<C, K>(...)` | Convenience hook — uses `userId` directly as syncId |
| `useLiveSync(syncId, options?)` | WebSocket sync hook with broadcast handling |
| `useUserLiveSync(userId, options?)` | Convenience hook — uses `userId` directly as syncId |
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
}
```

Mutations automatically retry on 5xx, 429, and network errors with exponential backoff (max 10s). All requests have a 10-second timeout — if the server doesn't respond within this time, a `TIMEOUT_ERROR` is thrown.

By default, mutations do **not** refetch from the server after success — optimistic updates combined with broadcast sync keep the cache accurate. Set `refetchOnSuccess: true` if you need extra certainty (e.g. custom server middleware that modifies data).

Note: `refetchOnSuccess` can be used together with `consistentReads: true` for maximum consistency guarantees.

#### Optimistic vs Pessimistic Updates

By default, all mutations are **optimistic** — the UI updates immediately before the server responds, providing instant feedback. If the server rejects the mutation, the cache is automatically rolled back.

For critical operations where you want to wait for server confirmation before showing changes to the user, use pessimistic mode:

```tsx
// Pessimistic: UI only updates after server confirms
const { data, update, isUpdating } = useCollection('todos', syncId, undefined, {
  optimisticUpdates: false
})

// Optimistic (default): UI updates instantly, rolls back on error
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

#### consistentReads Option

Enable consistent reads to route GET requests through the Durable Object instead of D1:

```ts
useCollection('todos', syncId, undefined, { consistentReads: true })
```

You can also enable it per-request by appending `?consistent=true` to the URL. This ensures consistency with broadcast counters after hibernation.

#### useLiveSync Options

```ts
interface UseLiveSyncOptions {
  scope?: string              // Filter broadcasts by scope
  party?: string              // PartyKit party/namespace (default: 'main')
  debug?: boolean             // Enable debug logging
  onError?: (error: Error) => void  // Error callback
  query?: Record<string, string> | (() => Record<string, string>)  // URL query params for auth tokens
}
```

### Server (`cf-sync-kit/server`)

| Export | Description |
|--------|-------------|
| `createDurableObject(config, opts)` | **Factory** — creates DO class with auto-registered repos. Supports `preset: 'per-user'` for quick setup |
| `createGetRoomFn(namespace)` | **Factory** — creates typed room resolver |
| `DurableObjectBase` | Base class for custom Durable Objects |
| `Repository` | CRUD operations for a Drizzle table |
| `createSyncApi(collections, getRoom, options?)` | Creates Hono router with sync endpoints |
| `createCollectionRouter(...)` | Creates router for a single collection |
| `omitSyncIdColumn(schema, column)` | Helper to omit syncId column from Zod schema |
| `MiddlewareSystem` | Middleware chain manager |
| `createAuthMiddleware(getUserId)` | Authentication middleware |
| `createCollectionFilterMiddleware(allowed)` | Collection access control |
| `createLoggingMiddleware()` | Mutation logging |
| `requireAuth()` | Requires `ctx.userId` to be set |
| `requireOwner(options?)` | Requires record owner matches `ctx.userId` |
| `createSyncAccessMiddleware(validate)` | Custom syncId access validation |
| `createDefaultSyncAccessValidator(prefix?)` | Helper for per-user syncId validation (default: exact match) |
| `createCollectionAccessMiddleware(rules)` | Granular action-specific collection access control |
| `CustomAccess` | Interface for custom access context (extend via module augmentation) |
| `BroadcastSystem` | Manages broadcast counters and event distribution |
| `WebSocketManager` | Manages WebSocket connections in the DO |
| `MiddlewareContext` | Context object passed to middleware functions |
| `Middleware` | Middleware function type |
| `RoomMutator` | Interface for DO room mutation methods |
| `GetRoomFn` | Type for room resolver function |
| `CollectionRouterOptions` | Options for createCollectionRouter / createSyncApi (includes `dbName` for custom D1 binding) |

### Shared Types

| Type | Description |
|------|-------------|
| `ActionType` | `'insert' \| 'update' \| 'delete' \| 'bulk-insert' \| 'bulk-update' \| 'bulk-delete'` |
| `CollectionConfig` | Config for a collection (table, schemas, syncIdColumn, singleTenant) |
| `CollectionsMap` | Map of collection names to configs |
| `InferInsert<C, K>` | Infer insert type from collection config |
| `InferUpdate<C, K>` | Infer update type from collection config |
| `InferEntity<C, K>` | Infer entity type from collection config |
| `MutationPayload` | Payload for a mutation operation |
| `PendingMutationInfo` | Tracks pending optimistic mutations |
| `CollectionName` | Collection name identifier |
| `Scope` | Scope string for filtering broadcasts |
| `EntityMap<T>` | Maps all collections to entity types |
| `InsertMap<T>` | Maps all collections to insert types |
| `UpdateMap<T>` | Maps all collections to update types |
| `WithId<T>` | Type with guaranteed `id: string` field |
| `CollectionKeys<T>` | Union of collection names |
| `ConnectionStatus` | `'connecting' \| 'connected' \| 'disconnected'` |
| `SyncError` | Custom error class with code, status, and details |
| `isSyncError(err)` | Type guard to check if error is a SyncError |
| `defineCollections(config)` | Type-safe config helper |

## Authorization

cf-sync-kit provides a two-layer authorization system with **server-side ownership injection**.

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

On insert, the router automatically injects `ownerId = userId` into the payload.

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
| **Insert** | Backend injects `ownerId = ctx.userId` and `syncIdColumn = syncId` — client cannot override |
| **Update** | Ownership enforced by syncId isolation (`createSyncAccessMiddleware`) |
| **Delete** | Ownership enforced by syncId isolation (`createSyncAccessMiddleware`) |

### Why two layers?

| Layer | Protects | When it runs |
|-------|----------|--------------|
| Router | GET, POST, PUT, DELETE | Before reaching DO |
| DO Middleware | Mutations only | Inside DO, before DB write |

The router layer prevents unauthorized reads. The DO layer provides defense-in-depth for mutations (useful if you have other entry points to the DO).

### Shared scopes

For shared sync scopes where multiple users access the same syncId, add custom middleware that queries the database to verify record ownership:

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
```

### Built-in middleware

| Middleware | Purpose |
|------------|---------|
| `requireAuth()` | Throws if `ctx.userId` is not set |
| `requireOwner(options?)` | Ensures `ownerId` in payload matches `ctx.userId` |
| `createSyncAccessMiddleware(validate)` | Custom syncId validation |
| `createDefaultSyncAccessValidator(prefix?)` | Helper for per-user syncId validation (default: exact match) |
| `createAuthMiddleware(getUserId)` | Auth inside DO (extracts userId from context) |
| `createCollectionFilterMiddleware(allowed)` | Restricts accessible collections |
| `createLoggingMiddleware()` | Logs mutations for debugging |

#### requireOwner Options

```ts
interface RequireOwnerOptions {
  checkOnUpdateDelete?: boolean  // Check ownership on update/delete (default: false)
  ownerField?: string            // Name of the owner field (default: 'ownerId')
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
requireOwner({ ownerField: 'createdBy' })
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

// Collection access control
this.use(createCollectionFilterMiddleware(['todos', 'notes']))

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

By default, `GET /:syncId` reads directly from D1 for performance. This can cause eventual consistency issues after Durable Object hibernation. Enable `consistentReads` to route reads through the DO:

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

Scopes allow multiple logical groups to share the same WebSocket and Durable Object without cross-contamination of updates.

```ts
// Client: each list gets its own scope
useLiveSync()
useCollection('todos', undefined, listIdA)
useCollection('todos', undefined, listIdB)
```

> **Tip:** When using scopes with foreign keys (e.g. `scope` references `lists.id`), use the raw ID as the scope value — not a prefixed string. This ensures the FK constraint is satisfied.

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

Bulk operations (`addMany`, `updateMany`, `removeMany`) are automatically batched to stay within D1's ~100 bound parameters limit. The batch size is calculated dynamically based on table column count:

- **`addMany`**: Uses `INSERT ... VALUES (...), (...), ...` with dynamic batch size (~5-18 items depending on columns). Each batch is a separate query.
- **`updateMany`**: Uses `db.batch([...])` to send multiple `UPDATE` queries in a single request. D1 executes them sequentially in an implicit transaction — if any statement fails, the entire batch is rolled back.
- **`removeMany`**: Uses `DELETE ... WHERE id IN (...)` with batches of up to 100 IDs.

**Partial failure semantics:**
- **If batch 1 succeeds but batch 2 fails**: Batch 1 results are committed. For `updateMany`, the failed batch is fully rolled back (D1 transaction). For `addMany`/`removeMany`, the failed batch is not applied.
- **Client cache**: On failure, the entire optimistic update is rolled back to `previousData`. The cache may temporarily diverge from the server until the next broadcast or refetch.
- **Retry behavior**: Failed batches retry with exponential backoff (same as single operations). If retries succeed, the broadcast will reconcile any cache divergence.

For critical operations where all-or-nothing semantics are required, use single operations or implement idempotency keys in your application logic.

## Running Tests

```bash
npm test          # Run once
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

This endpoint is useful for:
- Load balancer health checks
- Kubernetes readiness/liveness probes
- Monitoring and alerting systems
- Verifying API availability before client initialization

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
- Each `syncId` maps to one Durable Object instance. All clients connecting to the same sync scope share the same DO and receive real-time broadcasts.

## Examples

- `example/todo-app` — Basic todo app with single-tenant mode (no syncId column)
- `example/bulk-todo` — Bulk operations
- `example/scoped-todos-app` — Single-tenant app with scope-based broadcast isolation per list
- `example/auth-todo-app` — Basic auth with user-scoped todos
- `example/project-roles-todo-app` — Project-based role permissions
