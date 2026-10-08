-- Read model tables of the projection integration tests
create table public.it_order_summaries (
  id uuid primary key,
  customer text,
  status text not null default 'open',
  items integer not null default 0,
  total numeric(12, 2) not null default 0,
  title text,
  fts tsvector generated always as (to_tsvector('simple', coalesce(title, ''))) stored
);
create index on public.it_order_summaries using gin (fts);

create table public.it_counters (
  id text primary key,
  n bigint not null default 0
);

create table public.it_order_lines (
  order_id uuid not null,
  line integer not null,
  sku text not null,
  primary key (order_id, line)
);
