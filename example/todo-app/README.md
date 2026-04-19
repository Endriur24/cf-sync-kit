# Basic Todo App Demo

The simplest example demonstrating basic CRUD operations with `cf-sync-kit`.

## Features

- **Basic CRUD operations**: `add`, `update`, `remove` for collections
- **Live sync**: Real-time updates across clients using `useLiveSync`
- **Connection status**: Display connection state with `useConnectionStatus`
- **Multiple collections**: Demonstrates working with both `todos` and `notes` collections
- **Custom API endpoint**: Shows how to add custom Hono routes (complete-all) that broadcast sync events
- **Single-tenant configuration**: All data is shared using `singleTenant: true`

## Key Functions Demonstrated

### Client-side
- `useCollection` - Hook for fetching and managing collection data
- `useLiveSync` - Hook for enabling real-time synchronization
- `useConnectionStatus` - Hook for tracking WebSocket connection state

### Server-side
- `createDurableObject` - Creates a Durable Object for sync state
- `createGetRoomFn` - Creates a function to get the sync room
- Custom Hono routes with `broadcastSyncEvent` for manual sync triggers

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
npm run dev
```

Or from this directory:
```bash
npm run dev
```

## Testing

1. Open http://localhost:5173
2. Add todos and notes
3. Open another browser window to see real-time sync
4. Click "Complete All" to trigger a custom API endpoint with broadcast

## Architecture

```
Request → Hono → Durable Object
                  ↓
            Broadcast sync events
```

This is the simplest example - a good starting point for understanding the basics of `cf-sync-kit`.
