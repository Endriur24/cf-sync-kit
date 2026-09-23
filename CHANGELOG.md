# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.26.17] - 2026-09-23

### Added

- Added the server-only `createAnalyticsEngineSink()` adapter with a fixed, documented Analytics Engine schema.
- Added event/level filtering, custom sampling indexes, explicit identifier transformation, and privacy-preserving defaults.
- Added sampling-aware Analytics Engine query examples for operational dashboards and alerts.

## [0.26.16] - 2026-09-23

### Added

- Added a central `configureObservability()` adapter for structured server and client telemetry.
- Added payload-free events for mutation queue wait, sequence reservation, D1 duration, completion/failure, receipt replay, broadcast recovery, and client gap recovery.
- Added optional structured console output suitable for Cloudflare Workers Logs and a synchronous sink compatible with Analytics Engine bindings.

## [0.26.15] - 2026-09-23

### Fixed

- Validation failures now return HTTP 400 with `VALIDATION_ERROR` and structured Zod issues, which the client preserves in `SyncError`.
- Stable entity IDs that conflict outside the current `syncId` now return HTTP 409 instead of being wrapped as internal server errors.

### Tests

- Added real workerd coverage for partial bulk retry, mutation-ID reuse, cross-scope and cross-tenant mutations, entity-ID conflicts, and Durable Object eviction with a hibernated WebSocket.

## [0.26.14] - 2026-09-23

### Fixed

- The `per-user` Durable Object preset now derives its ownership check from each collection's `ownerColumn` instead of always checking `ownerId`.
- The `per-user` preset now fails fast during setup when a configured ownership column is absent from its Drizzle table.
- Added real workerd coverage for custom ownership columns and negative single-insert ownership checks.
- Aligned the authenticated example's `ownerColumn` with its existing `owner_id` isolation column.

## [0.26.13] - 2026-09-23

### Fixed

- Scoped mutation results and broadcasts now update both the matching scoped cache and the unscoped cache for the same collection and `syncId`.
- Broadcasts for one scope no longer leave another existing matching cache stale merely because `useLiveSync` was initialized with a different legacy scope option.
- Gap and reconnect recovery now refetch all relevant caches in the room because broadcast sequence counters are collection-wide, not scope-specific.

## [0.26.12] - 2026-09-23

### Added

- Added configurable mutation-receipt retention with a 24-hour TTL and a maximum of 512 receipts per Durable Object room by default.
- Added real workerd fault-injection coverage for failures before D1 writes, after D1 commits, and during WebSocket publication.

### Fixed

- Retrying a committed mutation after a broadcast failure now republishes its stored event with the original sequence ID instead of returning silently.
- Mutation receipts are pruned opportunistically without consuming the application's single Durable Object alarm.

## [0.26.11] - 2026-09-22

### Documentation

- Clarified that `syncId`, not `scope`, is the authorization and confidentiality boundary; scope filtering happens in D1 queries and client caches while room members can receive complete broadcast payloads.
- Documented WebSocket authorization exports, the three authorization layers, authoritative optimistic-error recovery, stable insert retry IDs, current D1 bulk limits, and real workerd test commands.
- Corrected the quick-start update schema so tenant and server-managed timestamp columns cannot be submitted by clients.

## [0.26.10] - 2026-09-22

### Added

- Added `createWebSocketHandler` with explicit public or authorized modes, edge authorization before Durable Object routing, trusted identity forwarding, and party restrictions.
- Added real workerd coverage for `DurableObjectBase`, `Repository`, D1 idempotency, middleware short-circuiting, authorized WebSocket upgrades, and broadcast delivery.

### Security

- The `per-user` Durable Object preset now rejects WebSocket connections without a verified user identity or when the identity differs from the room `syncId`.
- WebSocket routing removes spoofed internal identity headers before applying the application authorizer.

## [0.26.9] - 2026-09-22

### Fixed

- Replaced whole-cache optimistic rollback with an authoritative query refresh, preventing a failed mutation from overwriting concurrently successful client mutations.

## [0.26.8] - 2026-09-22

### Fixed

- Kept bulk deletes within D1's 100-bound-parameter limit by reserving parameters for `syncId`, optional scope, and soft-delete values.
- Validated every bulk-update statement independently and now report an actionable error before sending an over-wide query to D1.

## [0.26.7] - 2026-09-22

### Fixed

- Made the published ESM entries importable directly by Node.js by emitting explicit `.js` extensions for relative imports.
- Cleaned `dist` before every library build and excluded runtime test fixtures from the npm package.
- Added a package smoke test for both public ESM entry points.

## [0.26.6] - 2026-09-22

### Fixed

- Made retried single and bulk inserts idempotent by carrying stable client-generated entity IDs through the protocol and returning records already committed inside the same `syncId` boundary.
- Prevented partially completed bulk-insert retries from generating a second set of entity IDs and duplicate rows.

## [0.26.5] - 2026-09-22

### Fixed

- Made the repository mutation the terminal operation of the middleware onion. Middleware that does not call `next()` now prevents the database write and broadcast, and repeated `next()` calls are rejected.

## [0.26.4] - 2026-09-22

### Added

- Added `ownerColumn` to collection, router, and Repository configuration, allowing server-side ownership injection and immutability checks to use a custom database column.

## [0.26.3] - 2026-09-22

### Added

- Added a Workers-runtime test command using the official `@cloudflare/vitest-plugin`; it verifies Durable Object RPC and D1 reads/writes against isolated local bindings.

## [0.26.2] - 2026-09-22

### Fixed

- Kept expected 4xx validation and authorization responses out of server-error logs and stopped exposing internal D1 error messages in GET responses.

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
