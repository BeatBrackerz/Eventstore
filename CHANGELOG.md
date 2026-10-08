# [1.3.0](https://github.com/beatbrackerz/eventstore/compare/v1.2.0...v1.3.0) (2026-10-08)


### Bug Fixes

* keep aggregates in commit order and harden projection stores ([3a1ac90](https://github.com/beatbrackerz/eventstore/commit/3a1ac90235ee6edc5e564aeebf76a6f372d6813c))


### Features

* optional monthly partitions, immutable events and pgaudit logging ([987b237](https://github.com/beatbrackerz/eventstore/commit/987b237acac1a3faad0cf8b3847b69cb9c4da2ee))
* projections and read models (CQRS) with exactly-once commits, optional Elasticsearch ([3201d37](https://github.com/beatbrackerz/eventstore/commit/3201d3765e23854bc209b4e224b6bb952c4660ac))

# [1.2.0](https://github.com/beatbrackerz/eventstore/compare/v1.1.1...v1.2.0) (2026-09-25)


### Bug Fixes

* allow several realtime subscriptions at once ([639878a](https://github.com/beatbrackerz/eventstore/commit/639878af8f9b54f7f68840abf0777e94a36f1c10))


### Features

* add sql/eventstore.sql with indexes and database functions ([fc1a00f](https://github.com/beatbrackerz/eventstore/commit/fc1a00fae854072e13a5e69bd70060a58566e9df))
* fast reads without Redis, single round-trip writes and updated toolchain ([8f0827b](https://github.com/beatbrackerz/eventstore/commit/8f0827b0776ea19aa0d1eb9b6eb8b15a7cee36c6))

## [1.1.1](https://github.com/beatbrackerz/eventstore/compare/v1.1.0...v1.1.1) (2026-01-20)


### Bug Fixes

* Bump dependencies and update package version ([78efe58](https://github.com/beatbrackerz/eventstore/commit/78efe583b4f62e68018ef3f96d16cfc0fa186ac6))

# [1.1.0](https://github.com/beatbrackerz/eventstore/compare/v1.0.0...v1.1.0) (2025-12-17)


### Features

* Introduce modular architecture with Supabase adapters and ports for event storage, caching, sequencing, and snapshots. ([2455927](https://github.com/beatbrackerz/eventstore/commit/2455927a228f2495f8a5cde1b1041d21bf25c44c))

# 1.0.0 (2025-12-15)


### Bug Fixes

* Refactor imports in eventstore.ts to consolidate types into a single module. ([77c226d](https://github.com/beatbrackerz/eventstore/commit/77c226db4678c9fbb8bf8485e6d56ea25ef08597))
