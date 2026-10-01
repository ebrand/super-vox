import pg from 'pg';

/** The schema every super-vox table lives in (quoted: it has a hyphen). */
export const SCHEMA = '"super-vox"';

/** Migrations, applied in order once each (see openDatabase). Never edit one that has shipped. */
const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: '001_accounts',
    sql: `
      create table ${SCHEMA}.accounts (
        id uuid primary key,
        google_sub text not null unique,
        email text not null,
        name text not null,
        created_at timestamptz not null default now(),
        last_signed_in timestamptz not null default now()
      );`,
  },
  {
    name: '002_inventories',
    sql: `
      create table ${SCHEMA}.inventories (
        account_id uuid not null references ${SCHEMA}.accounts (id) on delete cascade,
        world text not null,
        items jsonb not null,
        hotbar jsonb not null,
        updated_at timestamptz not null default now(),
        primary key (account_id, world)
      );`,
  },
];

/** Connects to Postgres (Supabase) and brings the "super-vox" schema up to date. */
export async function openDatabase(connectionString: string): Promise<pg.Pool> {
  const pool = new pg.Pool({ connectionString, max: 4, ssl: sslFor(connectionString) });
  const client = await pool.connect();
  try {
    await client.query('begin');
    // One migrator at a time (e.g. two deploys overlapping).
    await client.query(`select pg_advisory_xact_lock(hashtext('super-vox migrations'))`);
    await client.query(`create schema if not exists ${SCHEMA}`);
    await client.query(`create table if not exists ${SCHEMA}.migrations (name text primary key, applied_at timestamptz not null default now())`);
    const done = new Set((await client.query<{ name: string }>(`select name from ${SCHEMA}.migrations`)).rows.map((r) => r.name));
    for (const m of MIGRATIONS) {
      if (done.has(m.name)) continue;
      await client.query(m.sql);
      await client.query(`insert into ${SCHEMA}.migrations (name) values ($1)`, [m.name]);
    }
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    await pool.end();
    throw err;
  } finally {
    client.release();
  }
  return pool;
}

/** TLS for remote databases (Supabase); none for a local one. */
function sslFor(connectionString: string): pg.PoolConfig['ssl'] {
  const host = new URL(connectionString).hostname;
  return host === 'localhost' || host === '127.0.0.1' ? false : { rejectUnauthorized: false };
}
