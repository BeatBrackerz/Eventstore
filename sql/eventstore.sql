-- =============================================================================
-- @beatbrackerz/eventstore – database schema, indexes and functions
-- =============================================================================
--
-- Safe to run on new and existing databases, and safe to run again: existing
-- tables keep their data, indexes are only created if no equivalent index
-- exists, and functions are replaced. Requires PostgreSQL 15 or newer (every
-- Supabase project qualifies).
--
-- The library detects the functions automatically. With them installed:
--   * appending events takes 1 request instead of 3 and allocates sequence
--     numbers atomically (no duplicates under concurrent writes),
--   * loading an aggregate (latest snapshot + following events) takes 1
--     request instead of 2,
--   * aggregate statistics are computed in the database,
--   * projections keep read models (tables, Elasticsearch indices) up to date:
--     events are read in commit order and every batch of read model changes
--     is stored together with the projection's checkpoint in one transaction.
--
-- Apply it in the Supabase SQL editor, with `psql`, or copy it into a
-- migration (`supabase migration new eventstore`).
--
-- Upgrading existing installations: the first run adds the columns
-- transaction_id and global_position to public.events. This rewrites the
-- table once and blocks reads and writes of it while it runs, so run it
-- outside peak hours on large tables.
--
-- Very large events tables: the index builds below lock writes to the table
-- while they run. To avoid that, create the indexes beforehand with
--   create unique index concurrently es_events_stream_uidx
--     on public.events (aggregate_id, aggregate_type, sequence_number);
--   create index concurrently es_events_type_created_at_idx
--     on public.events (type, created_at);
--   create index concurrently es_events_position_idx
--     on public.events (transaction_id, global_position);
-- (the last one after the columns exist) and this script will skip them.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Identifiers
-- -----------------------------------------------------------------------------

-- Time-ordered UUID (version 7, RFC 9562): 48-bit Unix time in milliseconds
-- followed by random bits. New ids are appended at the right edge of the
-- primary key index instead of landing on random pages, which keeps the index
-- compact and cuts write amplification compared to gen_random_uuid().
create or replace function public.es_uuid_v7()
returns uuid
language sql
volatile
parallel safe
set search_path = ''
as $$
  select encode(
    set_bit(
      set_bit(
        overlay(
          uuid_send(gen_random_uuid())
          placing substring(int8send(floor(extract(epoch from clock_timestamp()) * 1000)::bigint) from 3)
          from 1 for 6
        ),
        52, 1
      ),
      53, 1
    ),
    'hex'
  )::uuid
$$;

-- -----------------------------------------------------------------------------
-- Tables (only created if missing)
-- -----------------------------------------------------------------------------

-- transaction_id and global_position order all events by commit: see es_read_all
create table if not exists public.events (
  id uuid not null default public.es_uuid_v7(),
  type varchar(255) not null,
  aggregate_id uuid not null,
  aggregate_type varchar(255) not null,
  sequence_number integer not null,
  version integer not null default 1,
  payload jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone not null default now(),
  created_by uuid not null,
  transaction_id xid8 not null default pg_current_xact_id(),
  global_position bigint generated always as identity,
  constraint events_pkey primary key (id)
);

-- One row per aggregate, updated by every append: free space on each page
-- lets PostgreSQL update rows in place (HOT) without touching the index
create table if not exists public.aggregate_sequences (
  aggregate_id uuid not null,
  aggregate_type varchar(255) not null,
  last_sequence integer not null default 0,
  constraint aggregate_sequences_pkey primary key (aggregate_id, aggregate_type)
) with (fillfactor = 80);

create table if not exists public.snapshots (
  id uuid not null default public.es_uuid_v7(),
  aggregate_id uuid not null,
  aggregate_type varchar(255) not null,
  sequence_number integer not null,
  state jsonb not null,
  version integer not null default 1,
  created_at timestamp with time zone not null default now(),
  constraint snapshots_pkey primary key (id)
);

-- Checkpoint of every projection: the position of the last event it has processed.
-- Only the server-side projector (service role) may read or change it.
create table if not exists public.es_projections (
  name text not null,
  version integer not null default 1,
  transaction_id xid8 not null default '0',
  global_position bigint not null default 0,
  updated_at timestamp with time zone not null default now(),
  constraint es_projections_pkey primary key (name)
) with (fillfactor = 50);

alter table public.es_projections enable row level security;

-- -----------------------------------------------------------------------------
-- Upgrades of existing installations
-- -----------------------------------------------------------------------------

-- Global order for existing events tables
do $$
begin
  if exists (
    select 1 from pg_attribute
    where attrelid = 'public.events'::regclass and attname = 'global_position' and not attisdropped
  ) then
    return;
  end if;

  -- Existing events get transaction id 0, so they sort before every new event. A constant
  -- default is a metadata-only change; the identity column rewrites the table once and numbers
  -- the rows in physical order, which for an append-only table is the order of insertion.
  alter table public.events
    add column if not exists transaction_id xid8 not null default '0',
    add column global_position bigint generated by default as identity;

  alter table public.events alter column transaction_id set default pg_current_xact_id();

  -- Projections need the events of an aggregate in sequence order. Where the physical order
  -- differs (rows moved by updates or reused space), the aggregate's positions are reassigned
  -- in sequence order. Only affected aggregates are touched.
  with inverted as (
    select distinct aggregate_id, aggregate_type
    from (
      select aggregate_id, aggregate_type,
             global_position < lag(global_position) over (
               partition by aggregate_id, aggregate_type order by sequence_number, id
             ) as is_inverted
      from public.events
    ) ordered
    where is_inverted
  ),
  ranked as (
    select e.id, e.aggregate_id, e.aggregate_type, e.global_position,
           row_number() over (partition by e.aggregate_id, e.aggregate_type order by e.sequence_number, e.id) as by_sequence,
           row_number() over (partition by e.aggregate_id, e.aggregate_type order by e.global_position) as by_position
    from public.events e
    join inverted i on i.aggregate_id = e.aggregate_id and i.aggregate_type = e.aggregate_type
  )
  update public.events e
  set global_position = p.global_position
  from ranked s
  join ranked p
    on p.aggregate_id = s.aggregate_id
   and p.aggregate_type = s.aggregate_type
   and p.by_position = s.by_sequence
  where e.id = s.id
    and e.global_position <> p.global_position;

  alter table public.events alter column global_position set generated always;
end;
$$;

-- Time-ordered ids for installations that still use random ones
do $$
declare
  v_table regclass;
begin
  foreach v_table in array array['public.events', 'public.snapshots']::regclass[] loop
    if exists (
      select 1
      from pg_attrdef d
      join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
      where d.adrelid = v_table and a.attname = 'id' and pg_get_expr(d.adbin, d.adrelid) = 'gen_random_uuid()'
    ) then
      execute format('alter table %s alter column id set default public.es_uuid_v7()', v_table);
    end if;
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- Storage settings for write-heavy tables
-- -----------------------------------------------------------------------------

-- Sets a storage parameter unless the table already has a value for it (session-local helper)
create or replace function pg_temp.es_default_reloption(p_table regclass, p_option text, p_value text)
returns void
language plpgsql
as $$
begin
  if not exists (
    select 1 from pg_class c, unnest(coalesce(c.reloptions, '{}')) as o(option)
    where c.oid = p_table and o.option like p_option || '=%'
  ) then
    execute format('alter table %s set (%s = %s)', p_table, p_option, p_value);
  end if;
end;
$$;

-- events only ever receives inserts. Vacuuming (freezing, visibility map) and statistics then
-- happen in small steps instead of after 20 % of the table changed: no large freeze bursts,
-- current statistics for the planner and cheap index-only scans for es_projection_status.
do $$
begin
  perform pg_temp.es_default_reloption('public.events', 'autovacuum_vacuum_insert_scale_factor', '0.05');
  perform pg_temp.es_default_reloption('public.events', 'autovacuum_analyze_scale_factor', '0.02');
  perform pg_temp.es_default_reloption('public.aggregate_sequences', 'fillfactor', '80');
end;
$$;

-- lz4 compresses and decompresses large JSON documents several times faster than the default
-- pglz at a similar ratio. Applies to newly written values; existing ones stay readable.
do $$
declare
  v_column record;
begin
  for v_column in
    select a.attrelid::regclass as table_name, a.attname as column_name
    from pg_attribute a
    where (a.attrelid, a.attname) in (
      ('public.events'::regclass, 'payload'),
      ('public.events'::regclass, 'metadata'),
      ('public.snapshots'::regclass, 'state')
    )
      and a.attcompression is distinct from 'l'
  loop
    begin
      execute format('alter table %s alter column %I set compression lz4', v_column.table_name, v_column.column_name);
    exception when others then
      raise notice 'eventstore: keeping the default compression for %.% (%)', v_column.table_name, v_column.column_name, sqlerrm;
    end;
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------

-- Indexes on p_table whose leading key columns are p_columns (session-local helper)
create or replace function pg_temp.es_indexes_on(p_table regclass, p_columns text[])
returns table (index_name text, is_unique boolean, key_columns integer)
language sql
stable
as $$
  select c.relname::text, i.indisunique, i.indnkeyatts::integer
  from pg_index i
  join pg_class c on c.oid = i.indexrelid
  where i.indrelid = p_table
    and i.indpred is null
    and i.indnkeyatts >= cardinality(p_columns)
    and (
      select array_agg(a.attname::text order by k.ord)
      from unnest(i.indkey::int2[]) with ordinality as k(attnum, ord)
      join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
      where k.ord <= cardinality(p_columns)
    ) = p_columns
$$;

-- Reading an aggregate's stream: WHERE aggregate_id = ? AND aggregate_type = ? ORDER BY sequence_number.
-- Unique, so the database rejects duplicate sequence numbers even from outdated clients.
do $$
declare
  v_columns constant text[] := array['aggregate_id', 'aggregate_type', 'sequence_number'];
  v_has_duplicates boolean;
begin
  if exists (
    select 1 from pg_temp.es_indexes_on('public.events', v_columns)
    where is_unique and key_columns = cardinality(v_columns)
  ) then
    return;
  end if;

  select exists (
    select 1
    from public.events
    group by aggregate_id, aggregate_type, sequence_number
    having count(*) > 1
  ) into v_has_duplicates;

  if not v_has_duplicates then
    create unique index es_events_stream_uidx on public.events (aggregate_id, aggregate_type, sequence_number);
    -- Created by an earlier run while duplicates existed
    drop index if exists public.es_events_stream_idx;
  else
    if not exists (select 1 from pg_temp.es_indexes_on('public.events', v_columns)) then
      create index es_events_stream_idx on public.events (aggregate_id, aggregate_type, sequence_number);
    end if;
    raise warning 'eventstore: public.events contains duplicate sequence numbers (caused by concurrent appends without es_append_events). '
      'Created a non-unique index instead of a unique one. List them with: '
      'select aggregate_id, aggregate_type, sequence_number, count(*) from public.events group by 1, 2, 3 having count(*) > 1; '
      'Fix them and run this script again to enforce uniqueness.';
  end if;
end;
$$;

-- getEventsByType: most recent events of a type
do $$
begin
  if not exists (select 1 from pg_temp.es_indexes_on('public.events', array['type', 'created_at'])) then
    create index es_events_type_created_at_idx on public.events (type, created_at);
  end if;
end;
$$;

-- Latest snapshot of an aggregate
do $$
begin
  if not exists (select 1 from pg_temp.es_indexes_on('public.snapshots', array['aggregate_id', 'aggregate_type', 'sequence_number'])) then
    create index es_snapshots_stream_idx on public.snapshots (aggregate_id, aggregate_type, sequence_number desc);
  end if;
end;
$$;

-- Projections: reading all events in commit order (es_read_all)
do $$
begin
  if not exists (select 1 from pg_temp.es_indexes_on('public.events', array['transaction_id', 'global_position'])) then
    create index es_events_position_idx on public.events (transaction_id, global_position);
  end if;
end;
$$;

-- Every index slows down every append. Report indexes whose columns are the leading columns of
-- another index (e.g. idx_events_aggregate_id of earlier setups): queries can use the longer one.
do $$
declare
  v_index record;
begin
  for v_index in
    with idx as (
      select i.indexrelid, i.indrelid, i.indisunique, c.relam,
             (select array_agg(k.attnum order by k.ord)
              from unnest(i.indkey::int2[]) with ordinality as k(attnum, ord)
              where k.ord <= i.indnkeyatts) as keys
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
      where i.indrelid in ('public.events'::regclass, 'public.snapshots'::regclass, 'public.aggregate_sequences'::regclass)
        and i.indpred is null
        and i.indexprs is null
    )
    select a.indexrelid::regclass as redundant, b.indexrelid::regclass as covering
    from idx a
    join idx b on b.indrelid = a.indrelid and b.indexrelid <> a.indexrelid and b.relam = a.relam
    where not a.indisunique
      and cardinality(a.keys) <= cardinality(b.keys)
      and b.keys[1:cardinality(a.keys)] = a.keys
      and (cardinality(a.keys) < cardinality(b.keys) or b.indisunique or a.indexrelid > b.indexrelid)
  loop
    raise notice 'eventstore: index % is probably redundant (covered by %). Dropping it speeds up appends: drop index concurrently %;',
      v_index.redundant, v_index.covering, v_index.redundant;
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- Functions
--
-- All functions run with the privileges of the caller (SECURITY INVOKER), so
-- table grants and row level security apply exactly as for direct table access.
-- -----------------------------------------------------------------------------

-- Append events atomically and return the stored rows in input order.
--
-- p_events: JSON array of objects with the columns type, aggregate_id,
-- aggregate_type, payload, metadata, created_by and version.
--
-- Sequence numbers are reserved with INSERT ... ON CONFLICT DO UPDATE on
-- aggregate_sequences. The row lock it takes is held until commit, which
-- serializes concurrent appends per aggregate: numbers are gap-free, unique
-- and become visible in order.
create or replace function public.es_append_events(p_events jsonb)
returns json
language plpgsql
set search_path = ''
as $$
declare
  v_result json;
begin
  if p_events is null or jsonb_typeof(p_events) <> 'array' then
    raise exception 'es_append_events: p_events must be a JSON array' using errcode = '22023';
  end if;

  with input as (
    select x.ord, r.type, r.aggregate_id, r.aggregate_type, r.version, r.payload, r.metadata, r.created_by
    from jsonb_array_elements(p_events) with ordinality as x(elem, ord)
    cross join lateral jsonb_populate_record(null::public.events, x.elem) as r
  ),
  counts as (
    select aggregate_id, aggregate_type, count(*) as n
    from input
    group by aggregate_id, aggregate_type
  ),
  reserved as (
    -- Locking counters in a fixed order prevents deadlocks between batches touching the same aggregates
    insert into public.aggregate_sequences as s (aggregate_id, aggregate_type, last_sequence)
    select aggregate_id, aggregate_type, n
    from counts
    order by aggregate_type, aggregate_id
    on conflict (aggregate_id, aggregate_type)
      do update set last_sequence = s.last_sequence + excluded.last_sequence
    returning s.aggregate_id, s.aggregate_type, s.last_sequence
  ),
  numbered as (
    select i.*,
           r.last_sequence - c.n
             + row_number() over (partition by i.aggregate_id, i.aggregate_type order by i.ord) as sequence_number
    from input i
    join counts c on c.aggregate_id = i.aggregate_id and c.aggregate_type = i.aggregate_type
    join reserved r on r.aggregate_id = i.aggregate_id and r.aggregate_type = i.aggregate_type
  ),
  inserted as (
    insert into public.events (type, aggregate_id, aggregate_type, sequence_number, version, payload, metadata, created_by)
    select type, aggregate_id, aggregate_type, sequence_number,
           coalesce(version, 1), coalesce(payload, '{}'::jsonb), coalesce(metadata, '{}'::jsonb), created_by
    from numbered
    order by ord
    returning *
  )
  select coalesce(json_agg(e order by n.ord), '[]'::json)
    into v_result
  from inserted e
  join numbered n
    on n.aggregate_id = e.aggregate_id
   and n.aggregate_type = e.aggregate_type
   and n.sequence_number = e.sequence_number;

  return v_result;
end;
$$;

-- Load an aggregate's events, optionally starting after its latest snapshot.
--
-- Returns {"snapshot": <snapshot row or null>, "events": [<event rows>]}.
-- With p_use_snapshot the latest snapshot at or before p_to_sequence is
-- returned and events start after it (p_from_sequence is ignored).
create or replace function public.es_load_stream(
  p_aggregate_id public.events.aggregate_id%type,
  p_aggregate_type public.events.aggregate_type%type,
  p_from_sequence integer default 1,
  p_to_sequence integer default null,
  p_use_snapshot boolean default false,
  p_limit integer default null
)
returns json
language plpgsql
stable
set search_path = ''
as $$
declare
  v_snapshot public.snapshots%rowtype;
  v_has_snapshot boolean := false;
  v_from integer := coalesce(p_from_sequence, 1);
  v_events json;
begin
  if p_use_snapshot then
    select s.* into v_snapshot
    from public.snapshots s
    where s.aggregate_id = p_aggregate_id
      and s.aggregate_type = p_aggregate_type
      and (p_to_sequence is null or s.sequence_number <= p_to_sequence)
    order by s.sequence_number desc
    limit 1;

    v_has_snapshot := found;
    v_from := case when v_has_snapshot then v_snapshot.sequence_number + 1 else 1 end;
  end if;

  select coalesce(json_agg(e order by e.sequence_number, e.id), '[]'::json)
    into v_events
  from (
    select ev.*
    from public.events ev
    where ev.aggregate_id = p_aggregate_id
      and ev.aggregate_type = p_aggregate_type
      and ev.sequence_number >= v_from
      and (p_to_sequence is null or ev.sequence_number <= p_to_sequence)
    order by ev.sequence_number, ev.id
    limit p_limit
  ) e;

  return json_build_object(
    'snapshot', case when v_has_snapshot then row_to_json(v_snapshot) end,
    'events', v_events
  );
end;
$$;

-- Aggregate statistics without transferring the stream.
-- Returns {"totalEvents", "firstEvent", "lastEvent", "eventTypes": [[type, count], ...]}
-- with event types in order of first appearance.
create or replace function public.es_aggregate_stats(
  p_aggregate_id public.events.aggregate_id%type,
  p_aggregate_type public.events.aggregate_type%type
)
returns json
language sql
stable
set search_path = ''
as $$
  with types as (
    select e.type, count(*) as cnt, min(e.sequence_number) as first_sequence
    from public.events e
    where e.aggregate_id = p_aggregate_id
      and e.aggregate_type = p_aggregate_type
    group by e.type
  )
  select json_build_object(
    'totalEvents', (select coalesce(sum(t.cnt), 0)::bigint from types t),
    'firstEvent', (
      select row_to_json(e)
      from public.events e
      where e.aggregate_id = p_aggregate_id
        and e.aggregate_type = p_aggregate_type
      order by e.sequence_number, e.id
      limit 1
    ),
    'lastEvent', (
      select row_to_json(e)
      from public.events e
      where e.aggregate_id = p_aggregate_id
        and e.aggregate_type = p_aggregate_type
      order by e.sequence_number desc, e.id desc
      limit 1
    ),
    'eventTypes', coalesce(
      (select json_agg(json_build_array(t.type, t.cnt) order by t.first_sequence, t.type) from types t),
      '[]'::json
    )
  );
$$;

-- Read events of all aggregates in commit order, for projections.
--
-- Positions are (transaction_id, global_position): global_position alone is not
-- enough, because numbers are drawn before commit and a transaction that started
-- earlier can commit later. Events are therefore only returned from transactions
-- older than every transaction still running (the snapshot's xmin): a reader that
-- has passed a position never receives an older event afterwards. Long-running
-- write transactions anywhere in the database delay projections accordingly.
--
-- Returns {"events": [...], "next": {"transaction_id", "global_position"}, "done"}.
-- "next" is the position to continue from. With filters it can be ahead of the
-- last returned event: events the reader is not interested in are skipped.
-- "done" is true when no further events are available right now.
create or replace function public.es_read_all(
  p_after_transaction_id xid8 default '0',
  p_after_position bigint default 0,
  p_limit integer default 1000,
  p_event_types text[] default null,
  p_aggregate_types text[] default null
)
returns json
language plpgsql
stable
set search_path = ''
as $$
declare
  v_horizon constant xid8 := pg_snapshot_xmin(pg_current_snapshot());
  v_events json;
  v_count integer;
  v_next_transaction_id xid8 := p_after_transaction_id;
  v_next_position bigint := p_after_position;
  v_head_transaction_id xid8;
  v_head_position bigint;
begin
  if p_limit is null or p_limit < 1 then
    raise exception 'es_read_all: p_limit must be positive' using errcode = '22023';
  end if;

  with page as (
    select ev.*
    from public.events ev
    where (ev.transaction_id, ev.global_position) > (p_after_transaction_id, p_after_position)
      and ev.transaction_id < v_horizon
      and (p_event_types is null or ev.type = any(p_event_types))
      and (p_aggregate_types is null or ev.aggregate_type = any(p_aggregate_types))
    order by ev.transaction_id, ev.global_position
    limit p_limit
  )
  select coalesce(json_agg(p order by p.transaction_id, p.global_position), '[]'::json),
         count(*),
         (array_agg(p.transaction_id order by p.transaction_id desc, p.global_position desc))[1],
         (array_agg(p.global_position order by p.transaction_id desc, p.global_position desc))[1]
    into v_events, v_count, v_head_transaction_id, v_head_position
  from page p;

  if v_count > 0 then
    v_next_transaction_id := v_head_transaction_id;
    v_next_position := v_head_position;
  end if;

  if v_count < p_limit and (p_event_types is not null or p_aggregate_types is not null) then
    -- Nothing else matches below the horizon: continue after the newest readable event
    select ev.transaction_id, ev.global_position
      into v_head_transaction_id, v_head_position
    from public.events ev
    where ev.transaction_id < v_horizon
    order by ev.transaction_id desc, ev.global_position desc
    limit 1;

    if found and (v_head_transaction_id, v_head_position) > (v_next_transaction_id, v_next_position) then
      v_next_transaction_id := v_head_transaction_id;
      v_next_position := v_head_position;
    end if;
  end if;

  return json_build_object(
    'events', v_events,
    'next', json_build_object('transaction_id', v_next_transaction_id::text, 'global_position', v_next_position),
    'done', v_count < p_limit
  );
end;
$$;

-- Apply a batch of read model changes and move a projection's checkpoint, atomically.
--
-- Nothing is applied and false is returned if the checkpoint is not at the expected
-- position or version (another process got there first, or the projection was rebuilt).
-- Every batch is therefore applied exactly once, even with several projectors.
--
-- p_changes: JSON array of statements, applied in order:
--   {"op": "upsert"|"increment"|"delete", "table": "<table in schema public>",
--    "key": [<conflict/key columns>], "columns": [<columns of every row>], "rows": [...]}
-- upsert inserts rows or updates the given columns of existing ones (other columns
-- keep their values), increment adds the given values to existing rows (inserting
-- them as initial values), delete removes rows by key. Every row of a statement has
-- the same columns and a different key; "key" must match a unique index of the table.
create or replace function public.es_project(
  p_projection text,
  p_version integer,
  p_expected_transaction_id xid8,
  p_expected_position bigint,
  p_transaction_id xid8,
  p_position bigint,
  p_changes jsonb default '[]'::jsonb
)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_checkpoint public.es_projections%rowtype;
  v_change jsonb;
  v_table regclass;
  v_keys text;
  v_columns text;
  v_assignments text;
begin
  insert into public.es_projections (name, version) values (p_projection, p_version)
  on conflict (name) do nothing;

  select * into v_checkpoint from public.es_projections where name = p_projection for update;

  if v_checkpoint.version <> p_version
     or v_checkpoint.transaction_id <> p_expected_transaction_id
     or v_checkpoint.global_position <> p_expected_position then
    return false;
  end if;

  for v_change in select value from jsonb_array_elements(coalesce(p_changes, '[]'::jsonb)) loop
    v_table := to_regclass(format('public.%I', v_change->>'table'));
    if v_table is null then
      raise exception 'es_project: table public.% does not exist', v_change->>'table' using errcode = '42P01';
    end if;
    if v_table in ('public.events'::regclass, 'public.snapshots'::regclass,
                   'public.aggregate_sequences'::regclass, 'public.es_projections'::regclass) then
      raise exception 'es_project: % is not a read model table', v_table using errcode = '42501';
    end if;

    select string_agg(format('%I', k), ', ') into v_keys from jsonb_array_elements_text(v_change->'key') as k;
    select string_agg(format('%I', c), ', ') into v_columns from jsonb_array_elements_text(v_change->'columns') as c;

    case v_change->>'op'
      when 'upsert' then
        select string_agg(format('%1$I = excluded.%1$I', c), ', ') into v_assignments
        from jsonb_array_elements_text(v_change->'columns') as c
        where c not in (select jsonb_array_elements_text(v_change->'key'));

        execute format(
          'insert into %1$s as t (%2$s) select %2$s from jsonb_populate_recordset(null::%1$s, $1) on conflict (%3$s) do %4$s',
          v_table, v_columns, v_keys, coalesce('update set ' || v_assignments, 'nothing')
        ) using v_change->'rows';

      when 'increment' then
        select string_agg(format('%1$I = coalesce(t.%1$I, 0) + excluded.%1$I', c), ', ') into v_assignments
        from jsonb_array_elements_text(v_change->'columns') as c
        where c not in (select jsonb_array_elements_text(v_change->'key'));

        execute format(
          'insert into %1$s as t (%2$s) select %2$s from jsonb_populate_recordset(null::%1$s, $1) on conflict (%3$s) do %4$s',
          v_table, v_columns, v_keys, coalesce('update set ' || v_assignments, 'nothing')
        ) using v_change->'rows';

      when 'delete' then
        select string_agg(format('t.%1$I = k.%1$I', c), ' and ') into v_assignments
        from jsonb_array_elements_text(v_change->'key') as c;

        execute format(
          'delete from %1$s as t using jsonb_populate_recordset(null::%1$s, $1) as k where %2$s',
          v_table, v_assignments
        ) using v_change->'rows';

      else
        raise exception 'es_project: unknown operation %', v_change->>'op' using errcode = '22023';
    end case;
  end loop;

  update public.es_projections
  set transaction_id = p_transaction_id, global_position = p_position, updated_at = now()
  where name = p_projection;

  return true;
end;
$$;

-- Empty a projection's tables and reset its checkpoint, so it is rebuilt from the first event.
-- Returns false without changing anything if a newer version of the projection owns the tables
-- (an instance still running old code must not wipe the new version's work). Without p_force,
-- a projection that is already stored with p_version is left alone: when several instances
-- start a new projection version at once, only the first one resets it.
create or replace function public.es_reset_projection(
  p_projection text,
  p_version integer,
  p_tables text[] default '{}',
  p_force boolean default false
)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_checkpoint public.es_projections%rowtype;
  v_created boolean;
  v_name text;
  v_table regclass;
begin
  insert into public.es_projections (name, version) values (p_projection, p_version)
  on conflict (name) do nothing
  returning true into v_created;

  select * into v_checkpoint from public.es_projections where name = p_projection for update;

  if v_checkpoint.version > p_version then
    return false;
  end if;
  if v_checkpoint.version = p_version and v_created is null and not coalesce(p_force, false) then
    return true;
  end if;

  foreach v_name in array coalesce(p_tables, '{}') loop
    v_table := to_regclass(format('public.%I', v_name));
    if v_table is null then
      raise exception 'es_reset_projection: table public.% does not exist', v_name using errcode = '42P01';
    end if;
    if v_table in ('public.events'::regclass, 'public.snapshots'::regclass,
                   'public.aggregate_sequences'::regclass, 'public.es_projections'::regclass) then
      raise exception 'es_reset_projection: % is not a read model table', v_table using errcode = '42501';
    end if;

    begin
      execute format('truncate table %s', v_table);
    exception when others then
      -- No TRUNCATE privilege, or the table is referenced by foreign keys
      execute format('delete from %s', v_table);
    end;
  end loop;

  update public.es_projections
  set version = p_version, transaction_id = '0', global_position = 0, updated_at = now()
  where name = p_projection;

  return true;
end;
$$;

-- How far each projection is behind: events not yet processed and the time the oldest
-- of them was written (null when the projection is up to date)
create or replace view public.es_projection_status
with (security_invoker = true)
as
select p.name,
       p.version,
       p.transaction_id,
       p.global_position,
       p.updated_at,
       (
         select count(*)
         from public.events e
         where (e.transaction_id, e.global_position) > (p.transaction_id, p.global_position)
       ) as pending_events,
       (
         select e.created_at
         from public.events e
         where (e.transaction_id, e.global_position) > (p.transaction_id, p.global_position)
         order by e.transaction_id, e.global_position
         limit 1
       ) as oldest_pending_at
from public.es_projections p;

-- -----------------------------------------------------------------------------
-- Privileges
-- -----------------------------------------------------------------------------

-- Supabase API roles (skipped on databases without them)
do $$
declare
  v_role text;
begin
  -- Projections run on the server with the service role, so their functions are not
  -- callable with the anon key or by signed-in users
  revoke execute on function public.es_read_all, public.es_project, public.es_reset_projection from public;

  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = v_role) then
      execute format('grant execute on function public.es_append_events, public.es_load_stream, public.es_aggregate_stats to %I', v_role);

      if v_role = 'service_role' then
        execute format('grant execute on function public.es_read_all, public.es_project, public.es_reset_projection to %I', v_role);
        execute format('grant select on public.es_projection_status to %I', v_role);
      else
        execute format('revoke execute on function public.es_read_all, public.es_project, public.es_reset_projection from %I', v_role);
        execute format('revoke all on public.es_projection_status from %I', v_role);
      end if;
    end if;
  end loop;
end;
$$;

-- With Supabase, tables in the public schema are reachable with the anon key unless row
-- level security is enabled. Existing setups are left as they are, but warned.
do $$
declare
  v_table regclass;
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    return;
  end if;

  foreach v_table in array array['public.events', 'public.snapshots', 'public.aggregate_sequences']::regclass[] loop
    if not (select relrowsecurity from pg_class where oid = v_table)
       and has_table_privilege('anon', v_table, 'SELECT, INSERT') then
      raise warning 'eventstore: row level security is disabled on % and the anon role may access it, so anyone with your anon key can read and write it. Use the service role key on the server and run: alter table % enable row level security;',
        v_table, v_table;
    end if;
  end loop;
end;
$$;

-- Make PostgREST pick up the new functions immediately
notify pgrst, 'reload schema';
