# Scoped Broadcast Demo

Demonstrates scope-based broadcast isolation with `cf-sync-kit`. Multiple collections share the same Durable Object but have isolated real-time updates per scope.

## Features

- **Server-side scope filtering**: Requests like `GET /default/scopedTodos?scope=list-123` execute targeted SQL queries in Cloudflare D1 (`WHERE scope = ?`), reading only the requested scope's rows and saving D1 Read Units!
- **Scope-based broadcast isolation**: Real-time changes in one scope do NOT trigger updates in other scopes
- **Shared WebSocket & Durable Object**: Multiple scopes use the same infrastructure but have isolated broadcasts and queries
- **Multiple collections**: `lists` and `scopedTodos` collections working together
- **Dynamic scope subpages**: Each list opens a dedicated subpage/view scoped to its listId
- **Single-tenant configuration**: All data is shared, but query fetching and broadcasts are scoped

## Key Functions Demonstrated

### Client-side
- `useCollection(collectionName, undefined, scope)` - Hook with scope parameter for server-side SQL filtering (`GET ?scope=...`) and scoped broadcasts
- `useLiveSync` - Real-time sync respecting scope boundaries
- `useConnectionStatus` - Connection state tracking

### Server-side
- `createDurableObject` - Single Durable Object handling multiple scopes
- Scope column in D1 database for server-side SQL query filtering and broadcast isolation
- Foreign key relationships with CASCADE delete

## Database Setup

Before running the app, set up the local D1 database:

```bash
npm run db:setup:local
```

This generates migrations from the schema and applies them locally. Run this again if you modify `shared/schema.ts`.

Before running the dev server, generate TypeScript types for Cloudflare bindings:

```bash
npm run cf-typegen
```

To use `db:studio`, update the database URL in `drizzle.config.ts` first.

## Running

From the project root:
```bash
npm run dev:scoped
```

Or from this directory:
```bash
npm run dev
```

## Testing

1. Open http://localhost:5173
2. Create multiple lists (each list gets its own scope)
3. Add todos to different lists
4. Open another browser window
5. Add/update/delete todos in one list - only that list updates in real-time
6. Other lists are NOT affected by the broadcast (scope isolation)

## Architecture

```
Request → Hono → Durable Object
                  ↓
        ┌─────────┴─────────┐
        ↓                   ↓
   Scope A              Scope B
   (list 1)             (list 2)
        ↓                   ↓
   Broadcast only      Broadcast only
   to scope A          to scope B
```

This example shows how to build applications where different data groups need isolated real-time updates while sharing the same infrastructure. Perfect for multi-list todo apps, channel-based chat, or workspace isolation.
