import { randomUUID } from 'node:crypto';
import pg from 'pg';

/** A player's account (signed in with Google). */
export interface Account {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

/** Who someone is at Google, from a verified ID token. */
export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string;
}

export interface AccountStore {
  /** The account for a Google identity, created on first sign-in; email and name kept current. */
  signIn(identity: GoogleIdentity): Promise<Account>;
  get(id: string): Promise<Account | null>;
  close?(): Promise<void>;
}

/** Accounts in memory (tests, and development without a database). */
export class MemoryAccountStore implements AccountStore {
  private readonly bySub = new Map<string, Account>();
  private readonly byId = new Map<string, Account>();

  async signIn({ sub, email, name }: GoogleIdentity): Promise<Account> {
    const existing = this.bySub.get(sub);
    const account = existing ? { ...existing, email, name } : { id: randomUUID(), email, name, createdAt: new Date().toISOString() };
    this.bySub.set(sub, account);
    this.byId.set(account.id, account);
    return account;
  }

  async get(id: string): Promise<Account | null> {
    return this.byId.get(id) ?? null;
  }
}

/** The schema every super-vox table lives in (quoted: it has a hyphen). */
export const SCHEMA = '"super-vox"';

/** Migrations, applied in order once each (see PgAccountStore.migrate). */
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
];

/** Accounts in Postgres (Supabase), in the "super-vox" schema. */
export class PgAccountStore implements AccountStore {
  private constructor(private readonly pool: pg.Pool) {}

  /** Connects and brings the schema up to date. */
  static async open(connectionString: string): Promise<PgAccountStore> {
    const pool = new pg.Pool({ connectionString, max: 4, ssl: sslFor(connectionString) });
    const store = new PgAccountStore(pool);
    await store.migrate();
    return store;
  }

  private async migrate(): Promise<void> {
    const client = await this.pool.connect();
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
      throw err;
    } finally {
      client.release();
    }
  }

  async signIn({ sub, email, name }: GoogleIdentity): Promise<Account> {
    const { rows } = await this.pool.query<{ id: string; email: string; name: string; created_at: Date }>(
      `insert into ${SCHEMA}.accounts (id, google_sub, email, name) values ($1, $2, $3, $4)
       on conflict (google_sub) do update set email = excluded.email, name = excluded.name, last_signed_in = now()
       returning id, email, name, created_at`,
      [randomUUID(), sub, email, name],
    );
    return toAccount(rows[0]!);
  }

  async get(id: string): Promise<Account | null> {
    const { rows } = await this.pool.query<{ id: string; email: string; name: string; created_at: Date }>(
      `select id, email, name, created_at from ${SCHEMA}.accounts where id = $1`,
      [id],
    );
    return rows[0] ? toAccount(rows[0]) : null;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function toAccount(r: { id: string; email: string; name: string; created_at: Date }): Account {
  return { id: r.id, email: r.email, name: r.name, createdAt: r.created_at.toISOString() };
}

/** TLS for remote databases (Supabase); none for a local one. */
function sslFor(connectionString: string): pg.PoolConfig['ssl'] {
  const host = new URL(connectionString).hostname;
  return host === 'localhost' || host === '127.0.0.1' ? false : { rejectUnauthorized: false };
}
