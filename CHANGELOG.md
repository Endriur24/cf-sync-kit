# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.23.0]: https://github.com/Endriur24/cf-sync-kit/compare/v0.22.1...v0.23.0
[0.22.1]: https://github.com/Endriur24/cf-sync-kit/compare/v0.22.0...v0.22.1
[0.22.0]: https://github.com/Endriur24/cf-sync-kit/compare/v0.21.0...v0.22.0
[0.21.0]: https://github.com/Endriur24/cf-sync-kit/compare/v0.20.1...v0.21.0
