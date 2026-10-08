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
-- Optional, enabled by calling them once (see their sections at the end):
--   select public.es_partition_events();  -- monthly partitions of events
--   select public.es_enable_audit();      -- immutable events + pgaudit
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
-- lets PostgreSQL update rows in place (HOT) without touching the index.
-- first_created_at: no event of the aggregate is older (set by es_append_events; null when
-- unknown, e.g. for aggregates appended before it existed). Lets reads of a partitioned events
-- table skip the months before the aggregate existed. Leave it null when importing events.
create table if not exists public.aggregate_sequences (
  aggregate_id uuid not null,
  aggregate_type varchar(255) not null,
  last_sequence integer not null default 0,
  first_created_at timestamp with time zone,
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

-- The tables that hold events: public.events itself, or its partitions once it is
-- partitioned (see es_partition_events)
create or replace function public.es_event_tables()
returns setof regclass
language sql
stable
set search_path = ''
as $$
  select 'public.events'::regclass
  where (select c.relkind from pg_catalog.pg_class c where c.oid = 'public.events'::regclass) = 'r'
  union all
  select t.relid from pg_catalog.pg_partition_tree('public.events') as t where t.isleaf and t.level > 0
$$;

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

-- Creation time of aggregates (metadata-only change: nullable column without default)
alter table public.aggregate_sequences add column if not exists first_created_at timestamp with time zone;

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
-- Partitioned tables have no storage of their own: their partitions get the settings.
do $$
declare
  v_table regclass;
begin
  for v_table in select public.es_event_tables() loop
    perform pg_temp.es_default_reloption(v_table, 'autovacuum_vacuum_insert_scale_factor', '0.05');
    perform pg_temp.es_default_reloption(v_table, 'autovacuum_analyze_scale_factor', '0.02');
  end loop;
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

-- Indexes of a table holding events (public.events or one of its partitions), each created
-- unless an equivalent index exists. Names start with es_<table>_.
--   (aggregate_id, aggregate_type, sequence_number): reading an aggregate's stream. Unique, so
--       the database rejects duplicate sequence numbers even from outdated clients.
--   (type, created_at): getEventsByType, most recent events of a type
--   (transaction_id, global_position): es_read_all, all events in commit order
create or replace function public.es_ensure_event_indexes(p_table regclass)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_schema text;
  v_table text;
  v_index record;
  v_existing record;
  v_has_duplicates boolean;
begin
  select n.nspname, c.relname into v_schema, v_table
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where c.oid = p_table;

  for v_index in
    select *
    from (values
      ('stream', array['aggregate_id', 'aggregate_type', 'sequence_number'], true),
      ('type_created_at_idx', array['type', 'created_at'], false),
      ('position_idx', array['transaction_id', 'global_position'], false)
    ) as v(suffix, columns, is_unique)
  loop
    -- Indexes whose leading key columns are the wanted ones
    select count(*) > 0 as has_any,
           coalesce(bool_or(i.indisunique and i.indnkeyatts = cardinality(v_index.columns)), false) as has_unique
      into v_existing
    from pg_catalog.pg_index i
    where i.indrelid = p_table
      and i.indpred is null
      and i.indnkeyatts >= cardinality(v_index.columns)
      and (
        select array_agg(a.attname::text order by k.ord)
        from unnest(i.indkey::int2[]) with ordinality as k(attnum, ord)
        join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
        where k.ord <= cardinality(v_index.columns)
      ) = v_index.columns;

    if not v_index.is_unique then
      if not v_existing.has_any then
        execute format('create index %I on %s (%s)', 'es_' || v_table || '_' || v_index.suffix, p_table,
                       array_to_string(v_index.columns, ', '));
      end if;
      continue;
    end if;

    if v_existing.has_unique then
      continue;
    end if;

    execute format(
      'select exists (select 1 from %s group by aggregate_id, aggregate_type, sequence_number having count(*) > 1)',
      p_table
    ) into v_has_duplicates;

    if not v_has_duplicates then
      execute format('create unique index %I on %s (aggregate_id, aggregate_type, sequence_number)',
                     'es_' || v_table || '_stream_uidx', p_table);
      -- Created by an earlier run while duplicates existed
      if to_regclass(format('%I.%I', v_schema, 'es_' || v_table || '_stream_idx')) is not null then
        execute format('drop index %I.%I', v_schema, 'es_' || v_table || '_stream_idx');
      end if;
    else
      if not v_existing.has_any then
        execute format('create index %I on %s (aggregate_id, aggregate_type, sequence_number)',
                       'es_' || v_table || '_stream_idx', p_table);
      end if;
      raise warning 'eventstore: % contains duplicate sequence numbers (caused by concurrent appends without es_append_events). '
        'Created a non-unique index instead of a unique one. List them with: '
        'select aggregate_id, aggregate_type, sequence_number, count(*) from % group by 1, 2, 3 having count(*) > 1; '
        'Fix them and run this script again to enforce uniqueness.', p_table, p_table;
    end if;
  end loop;
end;
$$;

do $$
declare
  v_table regclass;
begin
  for v_table in select public.es_event_tables() loop
    perform public.es_ensure_event_indexes(v_table);
  end loop;
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
      where i.indrelid in (
          select public.es_event_tables()
          union all select 'public.snapshots'::regclass
          union all select 'public.aggregate_sequences'::regclass
        )
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
--
-- Within each aggregate, commit order (transaction id) follows the sequence
-- numbers, which projections rely on. A transaction gets its id with its first
-- write; a batch that got it before waiting for the lock of a further aggregate
-- could otherwise follow an append that started later. Such a batch fails with
-- SQLSTATE 40001 instead and is retried by the library with a new id.
-- Call the function as the first write of a transaction.
create or replace function public.es_append_events(p_events jsonb)
returns json
language plpgsql
set search_path = ''
-- Cached generic plans skip partitions at run time; custom plans would be planned per call
set plan_cache_mode = force_generic_plan
as $$
declare
  v_previous jsonb;
  v_result json;
begin
  if p_events is null or jsonb_typeof(p_events) <> 'array' then
    raise exception 'es_append_events: p_events must be a JSON array' using errcode = '22023';
  end if;

  -- Reserve sequence numbers; v_previous holds each aggregate's last sequence number before this batch
  with input as (
    select r.aggregate_id, r.aggregate_type
    from jsonb_array_elements(p_events) as x(elem)
    cross join lateral jsonb_populate_record(null::public.events, x.elem) as r
  ),
  counts as (
    select aggregate_id, aggregate_type, count(*) as n
    from input
    group by aggregate_id, aggregate_type
  ),
  reserved as (
    -- Locking counters in a fixed order prevents deadlocks between batches touching the same aggregates.
    -- first_created_at stays null when it is unknown (counter created without it).
    insert into public.aggregate_sequences as s (aggregate_id, aggregate_type, last_sequence, first_created_at)
    select aggregate_id, aggregate_type, n, now()
    from counts
    order by aggregate_type, aggregate_id
    on conflict (aggregate_id, aggregate_type)
      do update set last_sequence = s.last_sequence + excluded.last_sequence,
                    first_created_at = case when s.first_created_at is not null
                                            then least(s.first_created_at, excluded.first_created_at) end
    returning s.aggregate_id, s.aggregate_type, s.last_sequence, s.first_created_at
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'aggregate_id', r.aggregate_id,
           'aggregate_type', r.aggregate_type,
           'last_sequence', r.last_sequence - c.n,
           'first_created_at', r.first_created_at
         )), '[]'::jsonb)
    into v_previous
  from reserved r
  join counts c on c.aggregate_id = r.aggregate_id and c.aggregate_type = r.aggregate_type;

  -- A new statement sees appends that committed while this one waited for their locks
  if exists (
    select 1
    from jsonb_populate_recordset(null::public.aggregate_sequences, v_previous) as p
    join public.events e
      on e.aggregate_id = p.aggregate_id
     and e.aggregate_type = p.aggregate_type
     and e.sequence_number = p.last_sequence
     and e.created_at >= coalesce(p.first_created_at, '-infinity')
    where e.transaction_id > pg_current_xact_id()
  ) then
    raise exception 'es_append_events: an append that started later committed first; retry'
      using errcode = '40001';
  end if;

  with input as (
    select x.ord, r.type, r.aggregate_id, r.aggregate_type, r.version, r.payload, r.metadata, r.created_by
    from jsonb_array_elements(p_events) with ordinality as x(elem, ord)
    cross join lateral jsonb_populate_record(null::public.events, x.elem) as r
  ),
  numbered as (
    select i.*,
           p.last_sequence
             + row_number() over (partition by i.aggregate_id, i.aggregate_type order by i.ord) as sequence_number
    from input i
    join jsonb_populate_recordset(null::public.aggregate_sequences, v_previous) as p
      on p.aggregate_id = i.aggregate_id and p.aggregate_type = i.aggregate_type
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

-- No event of the aggregate is older than this (-infinity when unknown)
create or replace function public.es_aggregate_since(
  p_aggregate_id public.events.aggregate_id%type,
  p_aggregate_type public.events.aggregate_type%type
)
returns timestamptz
language sql
stable
parallel safe
set search_path = ''
as $$
  select coalesce(
    (select s.first_created_at from public.aggregate_sequences s
     where s.aggregate_id = p_aggregate_id and s.aggregate_type = p_aggregate_type),
    '-infinity'
  )
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
-- Cached generic plans skip partitions at run time; custom plans would be planned per call
set plan_cache_mode = force_generic_plan
as $$
declare
  v_snapshot public.snapshots%rowtype;
  v_has_snapshot boolean := false;
  v_from integer := coalesce(p_from_sequence, 1);
  v_since timestamptz;
  v_events json;
begin
  -- No event of the aggregate is older: on a partitioned table, earlier months are skipped
  v_since := public.es_aggregate_since(p_aggregate_id, p_aggregate_type);

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
      and ev.created_at >= v_since
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
language plpgsql
stable
set search_path = ''
-- Cached generic plans skip partitions at run time; custom plans would be planned per call
set plan_cache_mode = force_generic_plan
as $$
declare
  -- On a partitioned table, months before the aggregate existed are skipped
  v_since constant timestamptz := public.es_aggregate_since(p_aggregate_id, p_aggregate_type);
  v_result json;
begin
  with types as (
    select e.type, count(*) as cnt, min(e.sequence_number) as first_sequence
    from public.events e
    where e.aggregate_id = p_aggregate_id
      and e.aggregate_type = p_aggregate_type
      and e.created_at >= v_since
    group by e.type
  )
  select json_build_object(
    'totalEvents', (select coalesce(sum(t.cnt), 0)::bigint from types t),
    'firstEvent', (
      select row_to_json(e)
      from public.events e
      where e.aggregate_id = p_aggregate_id
        and e.aggregate_type = p_aggregate_type
        and e.created_at >= v_since
      order by e.sequence_number, e.id
      limit 1
    ),
    'lastEvent', (
      select row_to_json(e)
      from public.events e
      where e.aggregate_id = p_aggregate_id
        and e.aggregate_type = p_aggregate_type
        and e.created_at >= v_since
      order by e.sequence_number desc, e.id desc
      limit 1
    ),
    'eventTypes', coalesce(
      (select json_agg(json_build_array(t.type, t.cnt) order by t.first_sequence, t.type) from types t),
      '[]'::json
    )
  )
  into v_result;

  return v_result;
end;
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
-- Nothing is applied and false is returned if the checkpoint is missing or not at the
-- expected position or version (another process got there first, or the projection was
-- rebuilt; es_reset_projection creates it). Every batch is therefore applied exactly once,
-- even with several projectors.
--
-- p_changes: JSON array of statements, applied in order:
--   {"op": "upsert"|"increment"|"delete", "table": "<table in schema public>",
--    "key": [<conflict/key columns>], "columns": [<columns of every row>], "rows": [...]}
-- upsert inserts rows or updates the given columns of existing ones (other columns
-- keep their values), increment adds the given values to existing rows (inserting
-- them as initial values), delete removes rows by key. Every row of a statement has
-- the same columns; "key" must match a unique index of the table. Rows with equal keys
-- (as compared by the column types) are merged: the last upsert wins, increments add up.
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
  v_sums text;
begin
  select * into v_checkpoint from public.es_projections where name = p_projection for update;

  if not found
     or v_checkpoint.version <> p_version
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
          'insert into %1$s as t (%2$s) '
          'select distinct on (%3$s) %2$s from jsonb_populate_recordset(null::%1$s, $1) with ordinality as r '
          'order by %3$s, r.ordinality desc '
          'on conflict (%3$s) do %4$s',
          v_table, v_columns, v_keys, coalesce('update set ' || v_assignments, 'nothing')
        ) using v_change->'rows';

      when 'increment' then
        select string_agg(format('%1$I = coalesce(t.%1$I, 0) + excluded.%1$I', c), ', '),
               string_agg(format('sum(%1$I)', c), ', ')
          into v_assignments, v_sums
        from jsonb_array_elements_text(v_change->'columns') as c
        where c not in (select jsonb_array_elements_text(v_change->'key'));

        execute format(
          'insert into %1$s as t (%2$s%3$s) '
          'select %2$s%4$s from jsonb_populate_recordset(null::%1$s, $1) group by %2$s '
          'on conflict (%2$s) do %5$s',
          v_table, v_keys,
          coalesce(', ' || (select string_agg(format('%I', c), ', ') from jsonb_array_elements_text(v_change->'columns') as c
                            where c not in (select jsonb_array_elements_text(v_change->'key'))), ''),
          coalesce(', ' || v_sums, ''),
          coalesce('update set ' || v_assignments, 'nothing')
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
  v_tables regclass[] := '{}';
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
    v_tables := v_tables || v_table;
  end loop;

  if cardinality(v_tables) > 0 then
    begin
      -- One statement, so foreign keys between the projection's own tables do not get in the way
      execute format('truncate table %s', array_to_string(v_tables::text[], ', '));
    exception when others then
      -- No TRUNCATE privilege, or referenced by other tables: delete, referencing tables
      -- (usually declared after the referenced ones) first
      for i in reverse cardinality(v_tables) .. 1 loop
        execute format('delete from %s', v_tables[i]);
      end loop;
    end;
  end if;

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
-- Optional: immutable events and audit logging
--
-- Not enabled by this script. Enable once with
--   select public.es_enable_audit();     -- protection + pgaudit
-- or protection only with
--   select public.es_protect_events();
-- -----------------------------------------------------------------------------

-- Events are facts: correct mistakes with new events. This trigger rejects UPDATE, DELETE and
-- TRUNCATE of events for every role, including the service role. Only the table owner can
-- remove it (drop trigger), which pgaudit logs as DDL.
create or replace function public.es_events_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'eventstore: events are immutable (% on %.% is not allowed)', tg_op, tg_table_schema, tg_table_name
    using errcode = '42501',
          hint = 'Record corrections as new events. The table owner can drop the trigger es_events_immutable to change stored events anyway.';
end;
$$;

-- Install the immutability triggers on public.events and its partitions (idempotent)
create or replace function public.es_protect_events()
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_table regclass;
begin
  -- Row triggers of a partitioned table are cloned to all its partitions, present and future
  if not exists (
    select 1 from pg_catalog.pg_trigger
    where tgrelid = 'public.events'::regclass and tgname = 'es_events_immutable'
  ) then
    create trigger es_events_immutable
      before update or delete on public.events
      for each row execute function public.es_events_immutable();
  end if;

  -- TRUNCATE triggers are not cloned: one per table (es_prepare_events_partition adds them to new partitions)
  for v_table in select 'public.events'::regclass union select public.es_event_tables() loop
    if not exists (select 1 from pg_catalog.pg_trigger where tgrelid = v_table and tgname = 'es_events_no_truncate') then
      execute format(
        'create trigger es_events_no_truncate before truncate on %s for each statement execute function public.es_events_immutable()',
        v_table
      );
    end if;
  end loop;
end;
$$;

-- Protect the events and log who tries to change them, with the pgaudit extension.
--
-- Object audit (role es_auditor): UPDATE and DELETE of events and of the projection
-- checkpoints, deleted sequence counters and changed snapshots are logged – with the user,
-- statement and time – even when the immutability trigger rejects them. Appends and reads are
-- not logged: the events themselves are the record of every change of your domain.
-- Session audit (p_session_log, default 'ddl, role'): schema changes (incl. partitions and
-- dropped triggers) and changes of roles and privileges, for every user of the database.
-- Pass null to leave pgaudit.log as it is.
--
-- The settings apply to new connections. Logs go to the PostgreSQL log (Supabase: Logs →
-- Postgres); keep them longer with a log drain. Without pgaudit the events are still protected.
create or replace function public.es_enable_audit(p_session_log text default 'ddl, role')
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_table regclass;
begin
  perform public.es_protect_events();

  begin
    -- Supabase keeps extensions in the schema "extensions"
    execute format('create extension if not exists pgaudit with schema %I',
                   case when to_regnamespace('extensions') is not null then 'extensions' else 'public' end);
  exception when others then
    raise warning 'eventstore: events are protected, but pgaudit is not available (%). On Supabase, enable it under Database → Extensions; elsewhere, install it and add it to shared_preload_libraries.', sqlerrm;
    return;
  end;

  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'es_auditor') then
    create role es_auditor nologin;
  end if;

  -- The audit role's privileges select what is logged; it cannot log in, so they grant nothing
  for v_table in select 'public.events'::regclass union select public.es_event_tables() loop
    execute format('grant update, delete on %s to es_auditor', v_table);
  end loop;
  grant update on public.snapshots to es_auditor;
  grant delete on public.aggregate_sequences to es_auditor;
  grant delete on public.es_projections to es_auditor;

  begin
    execute format('alter database %I set pgaudit.role = %L', current_database(), 'es_auditor');
    execute format('alter database %I set pgaudit.log_catalog = off', current_database());
    if p_session_log is not null then
      execute format('alter database %I set pgaudit.log = %L', current_database(), p_session_log);
    end if;
  exception when insufficient_privilege then
    raise warning 'eventstore: events are protected and es_auditor exists, but this role may not configure pgaudit for the database (%). '
      'Run as a superuser (on Supabase: alter role postgres set ... for the postgres role): '
      'alter database % set pgaudit.role = ''es_auditor''; alter database % set pgaudit.log = %L;',
      sqlerrm, current_database(), current_database(), coalesce(p_session_log, 'ddl, role');
    return;
  end;

  raise notice 'eventstore: auditing enabled for new connections to database %', current_database();
end;
$$;

-- -----------------------------------------------------------------------------
-- Optional: monthly partitions of the events table
--
-- Not enabled by this script. Convert once with
--   select public.es_partition_events();
--
-- Each month's events live in their own partition (events_y2026m10, ...): appends only touch the
-- small indexes of the current month, autovacuum works month by month and finished months are
-- frozen once, and old months can be detached and archived. Reads of an aggregate's stream
-- visit every partition's index (there is no date in such a query), so keep the number of
-- partitions reasonable – a few years of months is fine.
--
-- Uniqueness of sequence numbers is enforced per partition; across partitions es_append_events
-- guarantees it (sequence numbers are allocated under a lock per aggregate).
-- -----------------------------------------------------------------------------

-- Primary key, indexes, storage settings, access, protection and audit of a partition
create or replace function public.es_prepare_events_partition(p_partition regclass)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_role text;
begin
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid = p_partition and contype = 'p') then
    execute format('alter table %s add primary key (id)', p_partition);
  end if;

  perform public.es_ensure_event_indexes(p_partition);

  if not exists (
    select 1 from pg_catalog.pg_class c, unnest(coalesce(c.reloptions, '{}')) as o(option)
    where c.oid = p_partition and o.option like 'autovacuum_vacuum_insert_scale_factor=%'
  ) then
    execute format('alter table %s set (autovacuum_vacuum_insert_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.02)', p_partition);
  end if;

  -- Partitions are read and written through public.events (whose grants and policies apply),
  -- never directly through the API
  execute format('alter table %s enable row level security', p_partition);
  foreach v_role in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_catalog.pg_roles where rolname = v_role) then
      execute format('revoke all on %s from %I', p_partition, v_role);
    end if;
  end loop;

  if exists (select 1 from pg_catalog.pg_trigger where tgrelid = 'public.events'::regclass and tgname = 'es_events_immutable')
     and not exists (select 1 from pg_catalog.pg_trigger where tgrelid = p_partition and tgname = 'es_events_no_truncate') then
    execute format(
      'create trigger es_events_no_truncate before truncate on %s for each statement execute function public.es_events_immutable()',
      p_partition
    );
  end if;

  if exists (select 1 from pg_catalog.pg_roles where rolname = 'es_auditor') then
    execute format('grant update, delete on %s to es_auditor', p_partition);
  end if;
end;
$$;

-- Create the partitions of the coming months (from the current month to p_months_ahead months
-- ahead, times in UTC) and a default partition. Safe to run any time; schedule it at least
-- monthly – es_partition_events does that with pg_cron. Events of a month without a partition
-- land in the default partition and are moved to their month's partition here.
create or replace function public.es_ensure_events_partitions(p_months_ahead integer default 3)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_month timestamptz;
  v_until constant timestamptz := date_trunc('month', now(), 'UTC') + make_interval(months => greatest(coalesce(p_months_ahead, 3), 0));
  v_next timestamptz;
  v_name text;
begin
  if (select c.relkind from pg_catalog.pg_class c where c.oid = 'public.events'::regclass) <> 'p' then
    raise notice 'eventstore: public.events is not partitioned; run select public.es_partition_events(); to partition it';
    return;
  end if;

  if to_regclass('public.events_default') is null then
    create table public.events_default partition of public.events default;
    perform public.es_prepare_events_partition('public.events_default');
  end if;

  -- Continue after the newest partition, but not before the current month
  select greatest(
           max(substring(pg_catalog.pg_get_expr(c.relpartbound, c.oid) from $re$ TO \('([^']+)'\)$re$)::timestamptz),
           date_trunc('month', now(), 'UTC')
         )
    into v_month
  from pg_catalog.pg_inherits i
  join pg_catalog.pg_class c on c.oid = i.inhrelid
  where i.inhparent = 'public.events'::regclass;

  while v_month <= v_until loop
    v_next := v_month + interval '1 month';
    v_name := 'events_' || to_char(v_month at time zone 'UTC', '"y"YYYY"m"MM');

    if to_regclass(format('public.%I', v_name)) is null then
      if not exists (select 1 from public.events_default where created_at >= v_month and created_at < v_next) then
        execute format('create table public.%I partition of public.events for values from (%L) to (%L)', v_name, v_month, v_next);
      else
        -- Move the month's events out of the default partition. Copies instead of DELETE,
        -- which the immutability trigger would reject.
        alter table public.events detach partition public.events_default;
        execute format('create table public.%I (like public.events including defaults including compression)', v_name);
        execute format('insert into public.%I select * from public.events_default where created_at >= $1 and created_at < $2', v_name)
          using v_month, v_next;
        create table public.events_default_rest (like public.events including defaults including compression);
        insert into public.events_default_rest
          select * from public.events_default where not (created_at >= v_month and created_at < v_next);
        drop table public.events_default;
        alter table public.events_default_rest rename to events_default;
        execute format('alter table public.events attach partition public.%I for values from (%L) to (%L)', v_name, v_month, v_next);
        alter table public.events attach partition public.events_default default;
        perform public.es_prepare_events_partition('public.events_default');
      end if;
      perform public.es_prepare_events_partition(format('public.%I', v_name)::regclass);
    end if;

    v_month := v_next;
  end loop;
end;
$$;

-- Convert public.events into a table partitioned by month of created_at.
--
-- The existing table becomes the partition events_legacy for everything before next month,
-- without copying data or rebuilding indexes; new months get their own partitions. It runs in
-- one transaction and blocks appends while it checks that no event is newer than that (one scan
-- of the table). For very large tables, do that check beforehand without blocking writes:
--   alter table public.events add constraint es_events_legacy_range
--     check (created_at < '<first day of next month>') not valid;
--   alter table public.events validate constraint es_events_legacy_range;
-- and run es_partition_events in the same month.
--
-- Grants, row level security and policies of the table are carried over. Foreign keys
-- referencing events and views on it (other than es_projection_status) must be dropped before.
create or replace function public.es_partition_events(p_months_ahead integer default 3)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_cutoff timestamptz := date_trunc('month', now(), 'UTC') + interval '1 month';
  v_constraint record;
  v_objects text;
  v_sequence text;
  v_next bigint;
  v_protected boolean;
  v_acl aclitem[];
  v_view text;
  v_view_acl aclitem[];
  v_grant record;
  v_policy record;
  v_rls record;
begin
  if (select c.relkind from pg_catalog.pg_class c where c.oid = 'public.events'::regclass) = 'p' then
    perform public.es_ensure_events_partitions(p_months_ahead);
    return;
  end if;

  -- Objects that would keep pointing at the old table
  select string_agg(c.conname || ' on ' || c.conrelid::regclass::text, ', ') into v_objects
  from pg_catalog.pg_constraint c
  where c.confrelid = 'public.events'::regclass and c.contype = 'f';
  if v_objects is not null then
    raise exception 'es_partition_events: foreign keys reference public.events (%). Drop them first: partitioned tables without a global primary key cannot be referenced.', v_objects;
  end if;

  select string_agg(distinct r.ev_class::regclass::text, ', ') into v_objects
  from pg_catalog.pg_depend d
  join pg_catalog.pg_rewrite r on r.oid = d.objid
  where d.classid = 'pg_catalog.pg_rewrite'::regclass
    and d.refobjid = 'public.events'::regclass
    and r.ev_class <> 'public.events'::regclass
    and r.ev_class is distinct from to_regclass('public.es_projection_status');
  if v_objects is not null then
    raise exception 'es_partition_events: views depend on public.events (%). Drop them first and create them again afterwards.', v_objects;
  end if;

  select string_agg(t.tgname, ', ') into v_objects
  from pg_catalog.pg_trigger t
  where t.tgrelid = 'public.events'::regclass and not t.tgisinternal
    and t.tgname not in ('es_events_immutable', 'es_events_no_truncate');
  if v_objects is not null then
    raise exception 'es_partition_events: public.events has triggers (%). Drop them first and create them on the partitioned table afterwards.', v_objects;
  end if;

  lock table public.events in access exclusive mode;

  -- No event may be newer than the legacy partition's range
  select c.convalidated, pg_catalog.pg_get_constraintdef(c.oid) as definition into v_constraint
  from pg_catalog.pg_constraint c
  where c.conrelid = 'public.events'::regclass and c.conname = 'es_events_legacy_range';
  if found then
    v_cutoff := substring(v_constraint.definition from $re$'([^']+)'$re$)::timestamptz;
    if not v_constraint.convalidated then
      alter table public.events validate constraint es_events_legacy_range;
    end if;
  else
    execute format('alter table public.events add constraint es_events_legacy_range check (created_at < %L)', v_cutoff);
  end if;

  -- Everything that is tied to the table and has to move to the partitioned one
  v_protected := exists (select 1 from pg_catalog.pg_trigger where tgrelid = 'public.events'::regclass and tgname = 'es_events_immutable');
  if v_protected then
    drop trigger es_events_immutable on public.events;
  end if;
  if exists (select 1 from pg_catalog.pg_trigger where tgrelid = 'public.events'::regclass and tgname = 'es_events_no_truncate') then
    drop trigger es_events_no_truncate on public.events;
  end if;

  select c.relacl, c.relrowsecurity as enabled, c.relforcerowsecurity as forced into v_rls
  from pg_catalog.pg_class c where c.oid = 'public.events'::regclass;
  v_acl := v_rls.relacl;

  if to_regclass('public.es_projection_status') is not null then
    v_view := pg_catalog.pg_get_viewdef('public.es_projection_status'::regclass);
    select c.relacl into v_view_acl from pg_catalog.pg_class c where c.oid = 'public.es_projection_status'::regclass;
    drop view public.es_projection_status;
  end if;

  -- Global positions continue from the identity sequence, which a partition cannot keep
  v_sequence := pg_catalog.pg_get_serial_sequence('public.events', 'global_position');
  if v_sequence is not null then
    execute format('select case when is_called then last_value + 1 else last_value end from %s', v_sequence) into v_next;
    alter table public.events alter column global_position drop identity if exists;
  end if;
  if v_next is null then
    select coalesce(max(global_position), 0) + 1 into v_next from public.events;
  end if;

  alter table public.events rename to events_legacy;

  create table public.events (like public.events_legacy including defaults including compression)
    partition by range (created_at);
  execute format('create sequence public.events_global_position_seq as bigint start with %s owned by public.events.global_position', v_next);
  alter table public.events alter column global_position set default nextval('public.events_global_position_seq');

  -- Uses the validated check constraint instead of scanning the table again
  execute format('alter table public.events attach partition public.events_legacy for values from (minvalue) to (%L)', v_cutoff);
  alter table public.events_legacy drop constraint es_events_legacy_range;

  -- Same privileges as before (new tables may have received default privileges); the owner keeps its own
  for v_grant in
    select distinct a.grantee
    from pg_catalog.pg_class c, pg_catalog.aclexplode(c.relacl) as a
    where c.oid = 'public.events'::regclass and a.grantee <> c.relowner
  loop
    execute format('revoke all on public.events from %s', case when v_grant.grantee = 0 then 'public' else quote_ident(pg_catalog.pg_get_userbyid(v_grant.grantee)) end);
  end loop;
  for v_grant in select a.grantee, a.privilege_type from pg_catalog.aclexplode(v_acl) as a loop
    execute format('grant %s on public.events to %s', v_grant.privilege_type,
                   case when v_grant.grantee = 0 then 'public' else quote_ident(pg_catalog.pg_get_userbyid(v_grant.grantee)) end);
    if v_grant.privilege_type = 'INSERT' then
      execute format('grant usage on sequence public.events_global_position_seq to %s',
                     case when v_grant.grantee = 0 then 'public' else quote_ident(pg_catalog.pg_get_userbyid(v_grant.grantee)) end);
    end if;
  end loop;

  if v_rls.enabled then
    alter table public.events enable row level security;
  end if;
  if v_rls.forced then
    alter table public.events force row level security;
  end if;
  for v_policy in
    select * from pg_catalog.pg_policies where schemaname = 'public' and tablename = 'events_legacy'
  loop
    execute format('create policy %I on public.events as %s for %s to %s%s%s',
      v_policy.policyname, v_policy.permissive, v_policy.cmd,
      (select string_agg(case when r = 'public' then 'public' else quote_ident(r) end, ', ') from unnest(v_policy.roles) as r),
      coalesce(' using (' || v_policy.qual || ')', ''),
      coalesce(' with check (' || v_policy.with_check || ')', ''));
  end loop;

  if exists (select 1 from pg_catalog.pg_publication_rel where prrelid = 'public.events_legacy'::regclass) then
    raise warning 'eventstore: events_legacy (the former events table) is in a publication. For Realtime on the partitioned table run: '
      'alter publication supabase_realtime add table public.events; alter publication supabase_realtime set (publish_via_partition_root = true);';
  end if;

  perform public.es_prepare_events_partition('public.events_legacy');

  -- A new installation needs no legacy partition
  if not exists (select 1 from public.events_legacy) then
    alter table public.events detach partition public.events_legacy;
    drop table public.events_legacy;
  end if;

  perform public.es_ensure_events_partitions(p_months_ahead);
  if v_protected then
    perform public.es_protect_events();
  end if;

  if v_view is not null then
    execute format('create view public.es_projection_status with (security_invoker = true) as %s', v_view);
    for v_grant in select a.grantee, a.privilege_type from pg_catalog.aclexplode(v_view_acl) as a loop
      execute format('grant %s on public.es_projection_status to %s', v_grant.privilege_type,
                     case when v_grant.grantee = 0 then 'public' else quote_ident(pg_catalog.pg_get_userbyid(v_grant.grantee)) end);
    end loop;
  end if;

  if exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    perform cron.schedule('eventstore-partitions', '7 3 * * *', 'select public.es_ensure_events_partitions()');
    raise notice 'eventstore: scheduled es_ensure_events_partitions daily with pg_cron (job eventstore-partitions)';
  else
    raise notice 'eventstore: schedule select public.es_ensure_events_partitions(); at least once a month, e.g. with pg_cron. '
      'Until then, events of months without a partition are stored in events_default.';
  end if;

  notify pgrst, 'reload schema';
end;
$$;

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

  -- Administration: only for the table owner (e.g. postgres in the SQL editor)
  foreach v_role in array array['public', 'anon', 'authenticated', 'service_role'] loop
    if v_role = 'public' or exists (select 1 from pg_roles where rolname = v_role) then
      execute format(
        'revoke execute on function public.es_event_tables, public.es_ensure_event_indexes, public.es_events_immutable, '
        'public.es_protect_events, public.es_enable_audit, public.es_prepare_events_partition, '
        'public.es_ensure_events_partitions, public.es_partition_events from %s',
        case when v_role = 'public' then 'public' else quote_ident(v_role) end
      );
    end if;
  end loop;

  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = v_role) then
      execute format('grant execute on function public.es_append_events, public.es_load_stream, public.es_aggregate_stats, public.es_aggregate_since to %I', v_role);

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
