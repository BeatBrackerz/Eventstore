-- Schema of installations that have not run sql/eventstore.sql (as documented up to v1.1.1):
-- no stream index and no database functions. Used to test the fallback paths.
create table public.events (
  id uuid not null default gen_random_uuid() primary key,
  type varchar(255) not null,
  aggregate_id uuid not null,
  aggregate_type varchar(255) not null,
  sequence_number integer not null,
  version integer not null default 1,
  payload jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone not null default now(),
  created_by uuid not null
);
create index idx_events_aggregate_id on public.events using btree (aggregate_id);
create index idx_events_aggregate_type on public.events using btree (aggregate_type);
create index idx_events_type on public.events using btree (type);

create table public.aggregate_sequences (
  aggregate_id uuid not null,
  aggregate_type varchar(255) not null,
  last_sequence integer not null default 0,
  primary key (aggregate_id, aggregate_type)
);

create table public.snapshots (
  id uuid not null default gen_random_uuid() primary key,
  aggregate_id uuid not null,
  aggregate_type varchar(255) not null,
  sequence_number integer not null,
  state jsonb not null,
  version integer not null default 1,
  created_at timestamp with time zone not null default now()
);
create index idx_snapshots_aggregate on public.snapshots using btree (aggregate_id, aggregate_type, sequence_number desc);
