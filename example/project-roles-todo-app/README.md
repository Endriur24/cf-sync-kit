# Project Roles Todo Demo

Demonstrates role-based authorization with `cf-sync-kit` in a multi-project scenario.

## Features

- Layered authorization (Hono middleware → Durable Object)
- `createCollectionAccessMiddleware` with action-specific rules
- Three roles with different permissions:
  - **Viewer**: Read-only access
  - **Editor**: Can add and update todos
  - **Admin**: Full access including delete and bulk operations

## Users

| Username | Password | Role   |
|----------|----------|--------|
| user     | password | viewer |
| editor   | password | editor |
| admin    | password | admin  |

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
npm run dev:roles
```

Or from this directory:
```bash
npm run dev
```

## Testing

1. Open http://localhost:5173
2. Log in with different users to see role-based UI changes:
   - **user**: Sees read-only list, no add/delete buttons
   - **editor**: Can add todos and mark them complete
   - **admin**: Can delete individual todos and use bulk delete

3. The role badge shows your current role at the top of the page.

## Architecture

```
Request → basicAuth → Sync API → Durable Object
                                    ↓
                          Role injection middleware
                                    ↓
                          createCollectionAccessMiddleware
                                    ↓
                          requireOwner
```

Roles are assigned based on userId inside the Durable Object middleware. The `createCollectionAccessMiddleware` enforces granular permissions per action (insert, update, delete, bulk-delete).
