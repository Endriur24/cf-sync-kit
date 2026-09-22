# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.26.1] - 2026-09-22

### Fixed

- Mutation callbacks now receive the documented public payload rather than TanStack Query's internal variables and receive the entity data rather than the transport envelope.

## [0.26.0] - 2026-09-22

### Added

- Added durable mutation receipts keyed by `_clientMutationId`: retries return the original result without repeating the write or broadcast, and reuse with different request data returns HTTP 409.

### Changed

- Serialized mutations within each Durable Object room and reserve broadcast sequence IDs before D1 writes. Failed writes intentionally leave detectable sequence gaps, triggering client recovery rather than silent stale state.

### Fixed

- A committed mutation whose websocket publication fails now returns HTTP 503 and can be safely retried with the same mutation ID.

## [0.25.1] - 2026-09-22

### Fixed

- Rejected client attempts to alter entity IDs, tenant/sync IDs, owner IDs, or scope columns during mutations.
- Applied scope constraints to update and delete queries, so a scoped request cannot mutate a record outside its scope.
- Returned HTTP 400 for invalid mutation payloads instead of continuing with an undefined validated body.
- Stored soft-delete timestamps as `Date` values, compatible with Drizzle SQLite timestamp columns.
- Corrected bulk write sizing for wide tables to stay within D1 parameter limits.

## [0.25.0] - 2026-08-31

### Added

- Added explicit connection lifecycle states: `reconnecting`, `synchronizing`, and `degraded`, along with `isReconnecting`, `isSynchronizing`, and `isDegraded` helpers from `useConnectionStatus()`.
- Added recovery when a tab becomes visible, returns from the back/forward cache, or receives the browser `online` hint. Recovery validates the socket with `ping`/`pong` and refetches affected queries before reporting `connected`.
- Added integration tests for `useLiveSync` covering connection state transitions, recovery events, broadcast gaps, cleanup, and multi-room aggregation.

### Changed

- `connected` is reported only after the initial or recovery refetch completes successfully; refetch failures now report `degraded`.
- The automatic connection lifecycle continuously retries failed transports and therefore reports `reconnecting` rather than `disconnected`.

### Fixed

- Prevented broadcasts and refetches from a previous socket session from overwriting counters, queues, or state after reconnecting.
- Cleared stale queued broadcasts when a new socket session opens and guarded gap-refetch counter updates against reconnect races.

## [0.24.1] - 2026-08-12

### Added

- Added `reorderOnUpdate` option to `UseCollectionOptions` (defaults to `false`). When `false`, `update` operations update items in-place preserving array order; when `true`, updated items are moved to the top of the collection list (`[updated, ...remaining]`).
- Added unit tests in `src/__tests__/cacheUpdater.test.ts` for `applyMutationToCache` and `reorderOnUpdate` behavior.

## [0.24.0] - 2026-08-12

### Added

- **Server-Side Result Ordering**: Added `orderByColumn` and `orderDirection` options to `CollectionConfig` and `CollectionRouterOptions` to configure sorting for collection queries.
- Automatic fallback ordering for `GET` handlers and `Repository.findAll(syncId, scope)`: defaults to `createdAt` (if available in schema) or `id`, using `desc` order (newest first).
- Propagated `orderByColumn` and `orderDirection` configuration through `createDurableObject` and `createSyncApi`.
- Added test coverage in `src/__tests__/ordering.test.ts` for custom and default ordering configuration.

## [0.23.1] - 2026-08-02

### Fixed

- Fixed missing `scope` parameter in `DurableObjectBase.broadcastSyncEvent`, which prevented scope-aware broadcast events from including scope context.

## [0.23.0] - 2026-08-01

### Added

- **Server-Side Scope Filtering**: Initial `GET` requests from `useCollection` now append `?scope=...` query parameters to execute targeted SQL queries in Cloudflare D1 (`WHERE scope = ?`), preventing full table reads and saving D1 Read Units.
- Added `scopeColumn` configuration option to `CollectionConfig` and `CollectionRouterOptions` (defaults to `'scope'`) allowing custom database column names for scope filtering (e.g. `list_id`, `category_id`).
- Updated `Repository.findAll(syncId, scope)`, `DurableObjectBase.findAll(collection, syncId, scope)`, and Hono router handlers to support server-side scope filtering.

## [0.22.1] - 2026-07-29

### Fixed

- Fixed an issue where websocket updates applied to data that hadn't been initially fetched yet, which resulted in the cache containing only the new partial data instead of all existing data.

## [0.22.0] - 2026-07-10

### Changed

- Updated all dependencies to latest versions
- **BREAKING**: `typescript` peerDependency updated to `>=7.0.0` (was `>=5.0.0`)
- `@hono/zod-validator`: 0.7.6 → 0.8.0
- `@types/node`: 25.5.2 → 26.1.1
- `typescript`: 5.0.0 → 7.0.2
- `vite-ssr-components`: 0.5.2 → 0.6.1
- `partyserver`: 0.4.1 → 0.5.8
- Added `drizzle-orm` to devDependencies for lib build compatibility
- Added `overrides` for `@cloudflare/workers-types@^5` to resolve peer dependency conflict between wrangler v5 and partyserver v4

## [0.21.0] - 2026-07-10

### Changed

- **BREAKING**: Restructured sync API endpoints. All collection routes now live under a single tenant prefix:
  - Multi-tenant: `/:syncId/:collection/[...]`
  - Single-tenant: `/default/:collection/[...]`
- **BREAKING**: Changed `DEFAULT_SYNC_ID` from `'_default'` to `'default'`.
- `useCollection` now calls `/${syncId}/${collection}/...` and no longer sends `syncId` in mutation bodies.

### Removed

- **BREAKING**: Removed the public export of `createCollectionRouter`. Use `createSyncApi` instead.

### Added

- Added `src/__tests__/createSyncApi.test.ts` covering all CRUD and bulk routes for both multi-tenant and single-tenant modes.

[0.25.0]: https://github.com/Endriur24/cf-sync-kit/compare/v0.24.11...v0.25.0
[0.24.1]: https://github.com/Endriur24/cf-sync-kit/compare/v0.24.0...v0.24.1
[0.24.0]: https://github.com/Endriur24/cf-sync-kit/compare/v0.23.1...v0.24.0
[0.23.1]: https://github.com/Endriur24/cf-sync-kit/compare/v0.23.0...v0.23.1
[0.23.0]: https://github.com/Endriur24/cf-sync-kit/compare/v0.22.1...v0.23.0
[0.22.1]: https://github.com/Endriur24/cf-sync-kit/compare/v0.22.0...v0.22.1
[0.22.0]: https://github.com/Endriur24/cf-sync-kit/compare/v0.21.0...v0.22.0
[0.21.0]: https://github.com/Endriur24/cf-sync-kit/compare/v0.20.1...v0.21.0
