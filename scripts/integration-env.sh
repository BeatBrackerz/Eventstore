#!/usr/bin/env bash
# Prepares two databases and PostgREST instances for the integration tests and benchmark:
#   es_it         with sql/eventstore.sql and the
#                 read model tables of the tests    -> PostgREST on port 3101
#   es_it_legacy  with the pre-1.2 schema only      -> PostgREST on port 3102
#
# Needs a running PostgreSQL (connection via the usual PG* environment variables) and psql.
# Downloads PostgREST unless POSTGREST_BIN points to a binary. Prints the environment
# variables the tests read; use: eval "$(scripts/integration-env.sh)"
set -euo pipefail

cd "$(dirname "$0")/.."

export PGHOST="${PGHOST:-localhost}" PGPORT="${PGPORT:-5432}" PGUSER="${PGUSER:-postgres}"
POSTGREST_VERSION="${POSTGREST_VERSION:-v14.18}"
JWT_SECRET="${EVENTSTORE_IT_JWT_SECRET:-eventstore-integration-test-secret-0123456789}"
WORKDIR="${WORKDIR:-$(mktemp -d)}"

run_psql() { psql -v ON_ERROR_STOP=1 -q "$@" >&2; }

for role in anon authenticated service_role; do
  run_psql -c "do \$\$ begin create role $role nologin; exception when duplicate_object then null; end \$\$"
done
run_psql -c "alter role service_role bypassrls"

for db in es_it es_it_legacy; do
  run_psql -c "drop database if exists $db"
  run_psql -c "create database $db"
done
# Twice: the script must be safe to run again
run_psql -d es_it -f sql/eventstore.sql
run_psql -d es_it -f sql/eventstore.sql
run_psql -d es_it -f test/integration/read-models.sql
run_psql -d es_it_legacy -f test/integration/legacy-schema.sql
for db in es_it es_it_legacy; do
  run_psql -d "$db" -c "grant usage on schema public to anon, authenticated, service_role; grant all on all tables in schema public to service_role"
done

if [[ -z "${POSTGREST_BIN:-}" ]]; then
  archive="postgrest-$POSTGREST_VERSION-linux-static-x86-64.tar.xz"
  curl -fsSL "https://github.com/PostgREST/postgrest/releases/download/$POSTGREST_VERSION/$archive" | tar -xJ -C "$WORKDIR"
  POSTGREST_BIN="$WORKDIR/postgrest"
fi

credentials="$PGUSER${PGPASSWORD:+:$PGPASSWORD}"
for instance in es_it:3101 es_it_legacy:3102; do
  db="${instance%%:*}" port="${instance##*:}"
  cat > "$WORKDIR/$db.conf" <<EOF
db-uri = "postgres://$credentials@$PGHOST:$PGPORT/$db"
db-schemas = "public"
db-anon-role = "anon"
jwt-secret = "$JWT_SECRET"
db-max-rows = 1000
server-host = "127.0.0.1"
server-port = $port
EOF
  nohup "$POSTGREST_BIN" "$WORKDIR/$db.conf" > "$WORKDIR/$db.log" 2>&1 &
  for _ in $(seq 1 30); do
    status="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/" || true)"
    [[ "$status" != "000" && "$status" != "503" ]] && break
    sleep 1
  done
done

echo "export EVENTSTORE_IT_POSTGREST_URL=http://127.0.0.1:3101"
echo "export EVENTSTORE_IT_POSTGREST_LEGACY_URL=http://127.0.0.1:3102"
echo "export EVENTSTORE_IT_JWT_SECRET=$JWT_SECRET"
