# Contributing

## Development

```bash
npm ci
npm run typecheck   # sources and tests
npm test            # unit tests; integration tests are skipped without their environment
npm run build       # ESM and CommonJS builds in dist/
```

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/): semantic-release derives the next version from them when changes reach `main` (`fix:`/`perf:` → patch, `feat:` → minor, `BREAKING CHANGE:` → major).

## Integration tests

The integration tests run the Supabase adapters against a real PostgREST (the REST layer of Supabase) with `db-max-rows = 1000` like Supabase, and the Redis cache against a real Redis. They need

- PostgreSQL 15 or newer and `psql` (connection via the usual `PG*` environment variables),
- Redis (optional).

`scripts/integration-env.sh` creates two databases – one with `sql/eventstore.sql` applied (twice, to check that it can be run again) plus the read model tables of the projection tests (`test/integration/read-models.sql`), and one with the schema of earlier versions – downloads PostgREST, starts one instance per database and prints the environment variables the tests read:

```bash
eval "$(PGHOST=localhost PGUSER=postgres scripts/integration-env.sh)"
export EVENTSTORE_IT_REDIS_URL=redis://localhost:6379/15
npm run test:integration
```

The script drops and recreates the databases `es_it` and `es_it_legacy`. Tests that need their own transactions or databases (commit order of projections, upgrading an existing events table) use `psql` with the same `PG*` variables and create `es_it_upgrade`. CI runs the same setup (see `.github/workflows/ci.yml`) and sets `EVENTSTORE_IT_REQUIRED` so that an incomplete environment fails instead of skipping the tests.

## Benchmark

`bench/run.ts` measures round trips, transferred data and latency of common operations against the integration environment, adding `BENCH_LATENCY_MS` (default 20) to every request. To compare with a previous release, build it and pass its entry point:

```bash
git worktree add /tmp/eventstore-baseline v1.1.1
(cd /tmp/eventstore-baseline && npm ci && npm run build)

npm run build
BENCH_BASELINE=/tmp/eventstore-baseline/dist/cjs/index.js npm run bench
```
