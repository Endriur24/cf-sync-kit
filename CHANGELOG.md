# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.21.0]: https://github.com/Endriur24/cf-sync-kit/compare/v0.20.1...v0.21.0
