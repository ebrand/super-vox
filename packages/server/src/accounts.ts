import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { SCHEMA } from './db.js';

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

/** Accounts in Postgres (Supabase), in the "super-vox" schema (see db.ts). */
export class PgAccountStore implements AccountStore {
  constructor(private readonly pool: pg.Pool) {}

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

}

function toAccount(r: { id: string; email: string; name: string; created_at: Date }): Account {
  return { id: r.id, email: r.email, name: r.name, createdAt: r.created_at.toISOString() };
}
