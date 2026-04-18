# Auth Todo Demo

Demonstrates user-scoped synchronization with authentication using `cf-sync-kit`.

## Features

- **User-scoped sync**: Each user has their own isolated Durable Object instance
- **Basic authentication**: Simple username/password auth with Hono middleware
- **Per-user data isolation**: Users can only see and sync their own todos
- **`useUserCollection`**: Hook for user-scoped collection access
- **`useUserLiveSync`**: Hook for user-scoped live synchronization
- **`syncIdColumn`**: Database column for isolating data per user

## Key Functions Demonstrated

### Client-side
- `useUserCollection` - Hook for user-scoped collection data
- `useUserLiveSync` - Hook for user-scoped real-time sync
- `useConnectionStatus` - Hook for tracking connection state

### Server-side
- `createSyncApi` - Creates sync API with authentication
- `createDefaultSyncAccessValidator` - Validates user can only access their own data
- `getUserId` - Extracts authenticated user from Hono context
- `validateSyncAccess` - Ensures proper data isolation

## Users

| Username | Password |
|----------|----------|
| admin    | password |
| user     | password |

## Database Setup

Before running the app, set up the local D1 database:

```bash
npm run db:setup:local
```

This generates migrations from the schema and applies them locally. Run this again if you modify `shared/schema.ts`.

## Running

From the project root:
```bash
npm run dev:auth
```

Or from this directory:
```bash
npm run dev
```

## Testing

1. Open http://localhost:5173
2. Log in with different users (admin/password or user/password)
3. Add todos - they are isolated per user
4. Open another browser with a different user to verify isolation
5. Log out and log in as a different user to see different data

## Architecture

```
Request → basicAuth → Sync API → Durable Object (per-user)
                                    ↓
                          Data isolated by owner_id
```

This example shows how to build multi-user applications where each user has their own synced data.
