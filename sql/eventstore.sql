-- =============================================================================
-- @beatbrackerz/eventstore – database schema, indexes and functions
-- =============================================================================
--
-- Safe to run on new and existing databases, and safe to run again: existing
-- tables are left untouched, indexes are only created if no equivalent index
-- exists, and functions are replaced.
--
-- The library detects the functions automatically. With them installed:
--   * appending events takes 1 request instead of 3 and allocates sequence
--     numbers atomically (no duplicates under concurrent writes),
--   * loading an aggregate (latest snapshot + following events) takes 1
--     request instead of 2,
--   * aggregate statistics are computed in the database.
--
-- Apply it in the Supabase SQL editor, with `psql`, or copy it into a
-- migration (`supabase migration new eventstore`).
--
-- Very large events tables: the index builds below lock writes to the table
-- while they run. To avoid that, create the indexes beforehand with
--   create unique index concurrently es_events_stream_uidx
--     on public.events (aggregate_id, aggregate_type, sequence_number);
--   create index concurrently es_events_type_created_at_idx
--     on public.events (type, created_at);
-- and this script will skip them.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Tables (only created if missing)
-- -----------------------------------------------------------------------------

create table if not exists public.events (
  id uuid not null default gen_random_uuid(),
  type varchar(255) not null,
  aggregate_id uuid not null,
  aggregate_type varchar(255) not null,
  sequence_number integer not null,
  version integer not null default 1,
  payload jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone not null default now(),
  created_by uuid not null,
  constraint events_pkey primary key (id)
);

create table if not exists public.aggregate_sequences (
  aggregate_id uuid not null,
  aggregate_type varchar(255) not null,
  last_sequence integer not null default 0,
  constraint aggregate_sequences_pkey primary key (aggregate_id, aggregate_type)
);

create table if not exists public.snapshots (
  id uuid not null default gen_random_uuid(),
  aggregate_id uuid not null,
  aggregate_type varchar(255) not null,
  sequence_number integer not null,
  state jsonb not null,
  version integer not null default 1,
  created_at timestamp with time zone not null default now(),
  constraint snapshots_pkey primary key (id)
);

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

-- Supabase API roles (skipped on databases without them)
do $$
declare
  v_role text;
begin
  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = v_role) then
      execute format('grant execute on function public.es_append_events to %I', v_role);
      execute format('grant execute on function public.es_load_stream to %I', v_role);
      execute format('grant execute on function public.es_aggregate_stats to %I', v_role);
    end if;
  end loop;
end;
$$;

-- Make PostgREST pick up the new functions immediately
notify pgrst, 'reload schema';
