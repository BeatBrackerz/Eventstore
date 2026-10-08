import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {beforeEach, describe, expect, it} from 'vitest';
import {postgresEnv} from '../support/postgrest.js';

const pg = postgresEnv();
const DB = 'es_it_partitioning';
const USER = '00000000-0000-0000-0000-000000000009';
const setupScript = readFileSync('sql/eventstore.sql', 'utf8');

/** stderr of a statement that has to fail */
function fails(sql: string): string {
    try {
        execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-qAt', '-d', DB, '-c', sql], { encoding: 'utf8', stdio: 'pipe' });
    } catch (err) {
        return String((err as { stderr?: string }).stderr);
    }
    throw new Error(`Expected to fail: ${sql}`);
}

const psql = (sql: string) => pg!.psql(DB, sql);
const append = (aggregateId: string, type: string) =>
    psql(`select e->>'global_position' from json_array_elements(public.es_append_events('[{"type":"${type}","aggregate_id":"${aggregateId}","aggregate_type":"t","created_by":"${USER}"}]')) e`);
const partitions = () => psql(`
    select string_agg(c.relname, ',' order by c.relname)
    from pg_inherits i join pg_class c on c.oid = i.inhrelid
    where i.inhparent = 'public.events'::regclass`).split(',');
const month = (offset: number) => {
    const date = new Date();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + offset);
    return `events_y${date.getUTCFullYear()}m${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
};

describe.skipIf(!pg)('monthly partitions and audit', () => {
    beforeEach(() => {
        pg!.psql('postgres', `drop database if exists ${DB}`);
        pg!.psql('postgres', `create database ${DB}`);
        psql(setupScript);
    });

    it('converts a populated events table without copying it and carries over access rules', () => {
        // History of earlier months, written before the conversion
        psql(`
            insert into public.events (type, aggregate_id, aggregate_type, sequence_number, created_by, created_at) values
              ('Old1', '00000000-0000-0000-0000-0000000000a1', 't', 1, '${USER}', now() - interval '3 months'),
              ('Old2', '00000000-0000-0000-0000-0000000000a1', 't', 2, '${USER}', now() - interval '2 months');
            insert into public.aggregate_sequences (aggregate_id, aggregate_type, last_sequence) values ('00000000-0000-0000-0000-0000000000a1', 't', 2);
            alter table public.events enable row level security;
            create policy readers on public.events for select to authenticated using (true);
            grant select on public.events to authenticated`);
        expect(append('00000000-0000-0000-0000-0000000000a1', 'Now1')).toBe('3');
        const legacyOid = psql(`select 'public.events'::regclass::oid`);

        psql('select public.es_partition_events(2)');

        expect(psql(`select relkind from pg_class where oid = 'public.events'::regclass`)).toBe('p');
        expect(partitions()).toEqual(['events_default', 'events_legacy', month(1), month(2)]);
        expect(psql(`select oid from pg_class where relname = 'events_legacy'`)).toBe(legacyOid); // same table, not a copy
        expect(psql(`select pg_get_expr(relpartbound, oid) from pg_class where relname = 'events_legacy'`)).toMatch(/^FOR VALUES FROM \(MINVALUE\) TO \('/);

        // Positions continue, events of all partitions in commit order, streams complete
        expect(append('00000000-0000-0000-0000-0000000000a1', 'Now2')).toBe('4');
        expect(psql(`select string_agg(e->>'type', ',') from json_array_elements(public.es_read_all()->'events') e`)).toBe('Old1,Old2,Now1,Now2');
        expect(psql(`select json_array_length(public.es_load_stream('00000000-0000-0000-0000-0000000000a1', 't')->'events')`)).toBe('4');
        expect(psql(`select (public.es_aggregate_stats('00000000-0000-0000-0000-0000000000a1', 't'))->>'totalEvents'`)).toBe('4');

        // Grants, row level security and policies move to the partitioned table; partitions are closed to the API
        expect(psql(`select relrowsecurity from pg_class where oid = 'public.events'::regclass`)).toBe('t');
        expect(psql(`select string_agg(policyname || ':' || array_to_string(roles, ','), ' ') from pg_policies where tablename = 'events'`)).toBe('readers:authenticated');
        expect(psql(`select has_table_privilege('authenticated', 'public.events', 'SELECT')`)).toBe('t');
        expect(psql(`select bool_and(c.relrowsecurity) and not bool_or(has_table_privilege('anon', c.oid, 'SELECT'))
                     from pg_inherits i join pg_class c on c.oid = i.inhrelid where i.inhparent = 'public.events'::regclass`)).toBe('t');

        // Every partition has its primary key and the event store's indexes
        expect(psql(`select string_agg(c.relname || '=' || (select count(*) from pg_index x where x.indrelid = c.oid), ',' order by c.relname)
                     from pg_inherits i join pg_class c on c.oid = i.inhrelid where i.inhparent = 'public.events'::regclass`))
            .toBe(['events_default', 'events_legacy', month(1), month(2)].map(name => `${name}=4`).join(','));

        // The status view reads the partitioned table, and the setup script can run again
        expect(psql(`select count(*) from pg_depend d join pg_rewrite r on r.oid = d.objid
                     where r.ev_class = 'public.es_projection_status'::regclass and d.refobjid = 'public.events'::regclass`)).not.toBe('0');
        psql(setupScript);
        expect(append('00000000-0000-0000-0000-0000000000a2', 'AfterRerun')).toBe('5');
    });

    it('starts a new installation with a partition per month', () => {
        psql('select public.es_partition_events(1)');

        expect(partitions()).toEqual(['events_default', month(0), month(1)]);
        append('00000000-0000-0000-0000-0000000000b1', 'First');
        expect(psql(`select tableoid::regclass from public.events`)).toBe(month(0));
        expect(psql(`select first_created_at = (select created_at from public.events) from public.aggregate_sequences`)).toBe('t');
    });

    it('moves events of months without a partition out of the default partition, also when events are protected', () => {
        psql('select public.es_partition_events(1); select public.es_protect_events()');
        psql(`insert into public.events (type, aggregate_id, aggregate_type, sequence_number, created_by, created_at)
              values ('Later', '00000000-0000-0000-0000-0000000000c1', 't', 1, '${USER}', date_trunc('month', now(), 'UTC') + interval '4 months 3 days')`);
        expect(psql(`select tableoid::regclass from public.events where type = 'Later'`)).toBe('events_default');

        psql('select public.es_ensure_events_partitions(5)');

        expect(psql(`select tableoid::regclass from public.events where type = 'Later'`)).toBe(month(4));
        expect(psql('select count(*) from public.events_default')).toBe('0');
        expect(psql(`select count(*) from pg_trigger where tgname = 'es_events_no_truncate'
                     and tgrelid in ('public.events_default'::regclass, 'public.${month(4)}'::regclass)`)).toBe('2');
    });

    it('rejects changes to stored events, on the table and on its partitions', () => {
        psql('select public.es_partition_events(1); select public.es_protect_events()');
        append('00000000-0000-0000-0000-0000000000d1', 'Created');

        expect(fails(`update public.events set type = 'x'`)).toMatch(/events are immutable \(UPDATE/);
        expect(fails(`delete from public.events`)).toMatch(/events are immutable \(DELETE/);
        expect(fails(`delete from public.${month(0)}`)).toMatch(/events are immutable \(DELETE/);
        expect(fails(`truncate public.events`)).toMatch(/events are immutable \(TRUNCATE/);
        expect(fails(`truncate public.${month(0)}`)).toMatch(/events are immutable \(TRUNCATE/);
        expect(append('00000000-0000-0000-0000-0000000000d1', 'StillAppends')).not.toBe('');
    });

    it('protects unpartitioned events tables too', () => {
        psql('select public.es_protect_events()');
        append('00000000-0000-0000-0000-0000000000e1', 'Created');
        expect(fails(`delete from public.events`)).toMatch(/events are immutable/);
        expect(fails(`truncate public.events`)).toMatch(/events are immutable/);
    });

    it('refuses to convert a table that foreign keys reference', () => {
        psql('create table public.event_refs (event_id uuid references public.events (id))');
        expect(fails('select public.es_partition_events()')).toMatch(/foreign keys reference public.events \(event_refs_event_id_fkey/);
        expect(psql(`select relkind from pg_class where oid = 'public.events'::regclass`)).toBe('r');
    });

    it('records when aggregates were created, and leaves it unknown for counters written without it', () => {
        append('00000000-0000-0000-0000-0000000000f1', 'Created');
        psql(`insert into public.aggregate_sequences (aggregate_id, aggregate_type, last_sequence) values ('00000000-0000-0000-0000-0000000000f2', 't', 1)`);
        append('00000000-0000-0000-0000-0000000000f2', 'Appended');

        expect(psql(`select string_agg((first_created_at is not null)::text, ',' order by aggregate_id) from public.aggregate_sequences`)).toBe('true,false');
        expect(psql(`select public.es_aggregate_since('00000000-0000-0000-0000-0000000000f2', 't')`)).toBe('-infinity');
    });

    it('configures pgaudit when it is available, and only protects events otherwise', () => {
        const available = psql(`select count(*) from pg_available_extensions where name = 'pgaudit'`) === '1'
            && psql(`select current_setting('shared_preload_libraries') like '%pgaudit%'`) === 't';

        psql('select public.es_enable_audit()');

        expect(psql(`select count(*) from pg_trigger where tgrelid = 'public.events'::regclass and tgname = 'es_events_immutable'`)).toBe('1');
        if (!available) return;

        expect(psql(`select array_to_string(setconfig, ' ') from pg_db_role_setting where setdatabase = (select oid from pg_database where datname = current_database())`))
            .toBe('pgaudit.role=es_auditor pgaudit.log_catalog=off pgaudit.log=ddl, role');
        expect(psql(`select has_table_privilege('es_auditor', 'public.events', 'UPDATE')
                       and has_table_privilege('es_auditor', 'public.events', 'DELETE')
                       and not has_table_privilege('es_auditor', 'public.events', 'INSERT')
                       and not has_table_privilege('es_auditor', 'public.events', 'SELECT')`)).toBe('t');
        expect(psql('show pgaudit.role')).toBe('es_auditor'); // new connection
    });
});
