# Bulk Todo Demo

Demonstrates bulk operations with `cf-sync-kit` for efficient batch data manipulation.

## Features

- **Bulk add**: `addMany` - Add multiple items in a single operation
- **Bulk update**: `updateMany` - Update multiple items at once
- **Bulk delete**: `removeMany` - Delete multiple items in one call
- **Loading states**: `isAddingMany`, `isUpdatingMany`, `isRemovingMany` for bulk operation status
- **Error handling**: `addManyError`, `updateManyError`, `removeManyError` for bulk operation errors
- **Single-tenant configuration**: All data is shared using `singleTenant: true`

## Key Functions Demonstrated

### Client-side
- `useCollection` with bulk methods:
  - `addMany(payloads)` - Add multiple items
  - `updateMany([{ id, data }])` - Update multiple items
  - `removeMany([ids])` - Delete multiple items
- Bulk loading states: `isAddingMany`, `isUpdatingMany`, `isRemovingMany`
- Bulk error states: `addManyError`, `updateManyError`, `removeManyError`
- `useLiveSync` - Real-time sync for bulk operations
- `useConnectionStatus` - Connection state tracking

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
npm run dev:bulk
```

Or from this directory:
```bash
npm run dev
```

## Testing

1. Open http://localhost:5173
2. Add multiple todos at once using the textarea (one per line)
3. Select multiple todos using checkboxes
4. Use bulk actions:
   - "Complete Selected" - marks selected as done
   - "Delete Selected" - removes selected items
   - "Complete ALL" - marks all todos as done
   - "Delete Completed" - removes all completed todos
5. Open another browser window to see bulk operations sync in real-time

## Architecture

```
Request → Hono → Durable Object
                  ↓
            Bulk operations broadcast single sync event
```

This example demonstrates how to efficiently handle batch operations, reducing network requests and improving UX for mass data manipulation.
