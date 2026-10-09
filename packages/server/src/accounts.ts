import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { parseAvatar, type Avatar } from '@super-vox/shared';
import { SCHEMA } from './db.js';

/**
 * What a player may do: admins run the place (players, worlds, designs: as ADMIN_EMAILS are), and
 * build; builders build; visitors only look round.
 */
export type Role = 'admin' | 'builder' | 'visitor';
export const ROLES: readonly Role[] = ['admin', 'builder', 'visitor'];
export const isRole = (v: unknown): v is Role => typeof v === 'string' && (ROLES as readonly string[]).includes(v);

/** A player's account (signed in with Google). */
export interface Account {
  id: string;
  email: string;
  name: string;
  createdAt: string;
  lastSignedIn: string;
  role: Role;
  /** Banned: signed out, and can't sign in again (until unbanned). */
  banned: boolean;
  /** Muted by an admin: plays, but can't chat. */
  muted: boolean;
  /** The name they've chosen to go by (see shownName), and how they look (see Avatar), if chosen. */
  displayName: string | null;
  avatar: Avatar | null;
}

/** The name a player goes by: theirs, if they've chosen one, else their Google name. */
export const shownName = (a: Pick<Account, 'name' | 'displayName'>): string => a.displayName ?? a.name;

/** Someone else goes by that name already. */
export class NameTakenError extends Error {}

/** Who someone is at Google, from a verified ID token. */
export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string;
}

/** An invitation to make an account: for a Google account's email, with the role it'll have. */
export interface Invite {
  email: string;
  role: Role;
  createdAt: string;
  /** Who invited them (an account's id), if known. */
  invitedBy: string | null;
  /** Used: the account it made, and when. */
  usedBy: string | null;
  usedAt: string | null;
}

/**
 * Where a player starts in a world, set by an admin (by email: an invitation's, before they've an
 * account, or an account's): where they first come into it, and come back to after dying without
 * a bed. Metres, as the game's Info panel shows them.
 */
export interface PersonalSpawn {
  email: string;
  world: string;
  x: number;
  z: number;
  setBy: string | null;
  updatedAt: string;
  /** Set by an admin, not to be changed by the player. */
  locked: boolean;
}

export interface AccountStore {
  /**
   * The account for a Google identity, created on first sign-in (with `role`, default builder);
   * email and name kept current. (Whether someone new may have one is for the caller: see Auth.)
   */
  signIn(identity: GoogleIdentity, role?: Role): Promise<Account>;
  get(id: string): Promise<Account | null>;
  /** The account for a Google identity, if there is one. */
  findBySub(sub: string): Promise<Account | null>;
  /** Every account, the most recently signed in first. */
  list(): Promise<Account[]>;
  setRole(id: string, role: Role): Promise<Account | null>;
  setBanned(id: string, banned: boolean): Promise<Account | null>;
  setMuted(id: string, muted: boolean): Promise<Account | null>;
  /** The name they go by (null: their Google name again). NameTakenError if anyone else goes by it (any case). */
  setDisplayName(id: string, name: string | null): Promise<Account | null>;
  /** How they look (null: as their name says, see defaultAvatar). */
  setAvatar(id: string, avatar: Avatar | null): Promise<Account | null>;
  /** Invitations, newest first. */
  invites(): Promise<Invite[]>;
  /** Invites `email` (lower-cased), as `role`; again: the role changes (an unused one). */
  invite(email: string, role: Role, by: string | null): Promise<Invite>;
  /** Takes an invitation back (true if there was one). */
  uninvite(email: string): Promise<boolean>;
  /** Uses the invitation for `email`, for account `accountId`: its role, or null if there's none unused. */
  takeInvite(email: string, accountId: string): Promise<Role | null>;
  /** Every personal spawn point (see PersonalSpawn). */
  spawns(): Promise<PersonalSpawn[]>;
  /** `email`'s spawn point in `world`, if one's been set (and whether an admin's locked it). */
  spawnFor(email: string, world: string): Promise<{ x: number; z: number; locked: boolean } | null>;
  /** Sets (or moves) `email`'s spawn point in `world`, locked (by an admin) or not. */
  setSpawn(email: string, world: string, x: number, z: number, by: string | null, locked?: boolean): Promise<PersonalSpawn>;
  /** Takes it away (true if there was one). */
  clearSpawn(email: string, world: string): Promise<boolean>;
}

const lower = (e: string) => e.trim().toLowerCase();

/** Accounts in memory (tests, and development without a database). */
export class MemoryAccountStore implements AccountStore {
  private readonly bySub = new Map<string, Account>();
  private readonly byId = new Map<string, Account>();
  private readonly invited = new Map<string, Invite>();
  private readonly spawnsByKey = new Map<string, PersonalSpawn>();

  async signIn({ sub, email, name }: GoogleIdentity, role: Role = 'builder'): Promise<Account> {
    const existing = this.bySub.get(sub);
    const now = new Date().toISOString();
    const account = existing ? { ...existing, email, name, lastSignedIn: now } : { id: randomUUID(), email, name, createdAt: now, lastSignedIn: now, role, banned: false, muted: false, displayName: null, avatar: null };
    this.put(sub, account);
    return account;
  }

  async get(id: string): Promise<Account | null> {
    return this.byId.get(id) ?? null;
  }

  async findBySub(sub: string): Promise<Account | null> {
    return this.bySub.get(sub) ?? null;
  }

  async list(): Promise<Account[]> {
    return [...this.byId.values()].sort((a, b) => b.lastSignedIn.localeCompare(a.lastSignedIn));
  }

  async setRole(id: string, role: Role): Promise<Account | null> {
    return this.update(id, { role });
  }

  async setBanned(id: string, banned: boolean): Promise<Account | null> {
    return this.update(id, { banned });
  }

  async setMuted(id: string, muted: boolean): Promise<Account | null> {
    return this.update(id, { muted });
  }

  async setDisplayName(id: string, name: string | null): Promise<Account | null> {
    if (name !== null && [...this.byId.values()].some((a) => a.id !== id && shownName(a).toLowerCase() === name.toLowerCase())) throw new NameTakenError(`someone goes by "${name}" already`);
    return this.update(id, { displayName: name });
  }

  async setAvatar(id: string, avatar: Avatar | null): Promise<Account | null> {
    return this.update(id, { avatar });
  }

  async invites(): Promise<Invite[]> {
    return [...this.invited.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async invite(email: string, role: Role, by: string | null): Promise<Invite> {
    const e = lower(email), was = this.invited.get(e);
    const inv: Invite = was && !was.usedBy ? { ...was, role } : { email: e, role, createdAt: new Date().toISOString(), invitedBy: by, usedBy: null, usedAt: null };
    this.invited.set(e, inv);
    return inv;
  }

  async uninvite(email: string): Promise<boolean> {
    return this.invited.delete(lower(email));
  }

  async takeInvite(email: string, accountId: string): Promise<Role | null> {
    const inv = this.invited.get(lower(email));
    if (!inv || inv.usedBy) return null;
    this.invited.set(inv.email, { ...inv, usedBy: accountId, usedAt: new Date().toISOString() });
    return inv.role;
  }

  async spawns(): Promise<PersonalSpawn[]> {
    return [...this.spawnsByKey.values()];
  }

  async spawnFor(email: string, world: string): Promise<{ x: number; z: number; locked: boolean } | null> {
    const s = this.spawnsByKey.get(`${lower(email)}\n${world}`);
    return s ? { x: s.x, z: s.z, locked: s.locked } : null;
  }

  async setSpawn(email: string, world: string, x: number, z: number, by: string | null, locked = false): Promise<PersonalSpawn> {
    const s: PersonalSpawn = { email: lower(email), world, x, z, setBy: by, updatedAt: new Date().toISOString(), locked };
    this.spawnsByKey.set(`${s.email}\n${world}`, s);
    return s;
  }

  async clearSpawn(email: string, world: string): Promise<boolean> {
    return this.spawnsByKey.delete(`${lower(email)}\n${world}`);
  }

  private put(sub: string, account: Account): void {
    this.bySub.set(sub, account);
    this.byId.set(account.id, account);
  }

  private update(id: string, change: Partial<Account>): Account | null {
    const a = this.byId.get(id);
    if (!a) return null;
    const next = { ...a, ...change };
    for (const [sub, b] of this.bySub) if (b.id === id) this.put(sub, next);
    return next;
  }
}

type Row = { id: string; email: string; name: string; created_at: Date; last_signed_in: Date; role: string; banned_at: Date | null; muted_at: Date | null; display_name: string | null; avatar: unknown };
const COLUMNS = 'id, email, name, created_at, last_signed_in, role, banned_at, muted_at, display_name, avatar';
type InviteRow = { email: string; role: string; created_at: Date; invited_by: string | null; used_by: string | null; used_at: Date | null };
const INVITE_COLUMNS = 'email, role, created_at, invited_by, used_by, used_at';

/** Accounts in Postgres (Supabase), in the "super-vox" schema (see db.ts). */
export class PgAccountStore implements AccountStore {
  constructor(private readonly pool: pg.Pool) {}

  async signIn({ sub, email, name }: GoogleIdentity, role: Role = 'builder'): Promise<Account> {
    const { rows } = await this.pool.query<Row>(
      `insert into ${SCHEMA}.accounts (id, google_sub, email, name, role) values ($1, $2, $3, $4, $5)
       on conflict (google_sub) do update set email = excluded.email, name = excluded.name, last_signed_in = now()
       returning ${COLUMNS}`,
      [randomUUID(), sub, email, name, role],
    );
    return toAccount(rows[0]!);
  }

  async get(id: string): Promise<Account | null> {
    const { rows } = await this.pool.query<Row>(`select ${COLUMNS} from ${SCHEMA}.accounts where id = $1`, [id]);
    return rows[0] ? toAccount(rows[0]) : null;
  }

  async findBySub(sub: string): Promise<Account | null> {
    const { rows } = await this.pool.query<Row>(`select ${COLUMNS} from ${SCHEMA}.accounts where google_sub = $1`, [sub]);
    return rows[0] ? toAccount(rows[0]) : null;
  }

  async list(): Promise<Account[]> {
    const { rows } = await this.pool.query<Row>(`select ${COLUMNS} from ${SCHEMA}.accounts order by last_signed_in desc`);
    return rows.map(toAccount);
  }

  async setRole(id: string, role: Role): Promise<Account | null> {
    const { rows } = await this.pool.query<Row>(`update ${SCHEMA}.accounts set role = $2 where id = $1 returning ${COLUMNS}`, [id, role]);
    return rows[0] ? toAccount(rows[0]) : null;
  }

  async setBanned(id: string, banned: boolean): Promise<Account | null> {
    const { rows } = await this.pool.query<Row>(
      `update ${SCHEMA}.accounts set banned_at = ${banned ? 'coalesce(banned_at, now())' : 'null'} where id = $1 returning ${COLUMNS}`,
      [id],
    );
    return rows[0] ? toAccount(rows[0]) : null;
  }

  async setMuted(id: string, muted: boolean): Promise<Account | null> {
    const { rows } = await this.pool.query<Row>(`update ${SCHEMA}.accounts set muted_at = ${muted ? 'coalesce(muted_at, now())' : 'null'} where id = $1 returning ${COLUMNS}`, [id]);
    return rows[0] ? toAccount(rows[0]) : null;
  }

  async setDisplayName(id: string, name: string | null): Promise<Account | null> {
    if (name !== null) {
      const { rows } = await this.pool.query(`select 1 from ${SCHEMA}.accounts where id <> $1 and lower(coalesce(display_name, name)) = lower($2) limit 1`, [id, name]);
      if (rows.length) throw new NameTakenError(`someone goes by "${name}" already`);
    }
    try {
      const { rows } = await this.pool.query<Row>(`update ${SCHEMA}.accounts set display_name = $2 where id = $1 returning ${COLUMNS}`, [id, name]);
      return rows[0] ? toAccount(rows[0]) : null;
    } catch (err) {
      // (Two choosing it at once: the unique index says.)
      if ((err as { code?: string }).code === '23505') throw new NameTakenError(`someone goes by "${name}" already`);
      throw err;
    }
  }

  async setAvatar(id: string, avatar: Avatar | null): Promise<Account | null> {
    const { rows } = await this.pool.query<Row>(`update ${SCHEMA}.accounts set avatar = $2 where id = $1 returning ${COLUMNS}`, [id, avatar === null ? null : JSON.stringify(avatar)]);
    return rows[0] ? toAccount(rows[0]) : null;
  }

  async invites(): Promise<Invite[]> {
    const { rows } = await this.pool.query<InviteRow>(`select ${INVITE_COLUMNS} from ${SCHEMA}.invites order by created_at desc`);
    return rows.map(toInvite);
  }

  async invite(email: string, role: Role, by: string | null): Promise<Invite> {
    const { rows } = await this.pool.query<InviteRow>(
      `insert into ${SCHEMA}.invites (email, role, invited_by) values ($1, $2, $3)
       on conflict (email) do update set role = excluded.role where ${SCHEMA}.invites.used_by is null
       returning ${INVITE_COLUMNS}`,
      [lower(email), role, by],
    );
    if (rows[0]) return toInvite(rows[0]);
    // (Already used: as it was.)
    const used = await this.pool.query<InviteRow>(`select ${INVITE_COLUMNS} from ${SCHEMA}.invites where email = $1`, [lower(email)]);
    return toInvite(used.rows[0]!);
  }

  async uninvite(email: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(`delete from ${SCHEMA}.invites where email = $1`, [lower(email)]);
    return (rowCount ?? 0) > 0;
  }

  async takeInvite(email: string, accountId: string): Promise<Role | null> {
    const { rows } = await this.pool.query<{ role: string }>(
      `update ${SCHEMA}.invites set used_by = $2, used_at = now() where email = $1 and used_by is null returning role`,
      [lower(email), accountId],
    );
    return rows[0] && isRole(rows[0].role) ? rows[0].role : null;
  }

  async spawns(): Promise<PersonalSpawn[]> {
    const { rows } = await this.pool.query<SpawnRow>(`select ${SPAWN_COLUMNS} from ${SCHEMA}.spawns order by email, world`);
    return rows.map(toSpawn);
  }

  async spawnFor(email: string, world: string): Promise<{ x: number; z: number; locked: boolean } | null> {
    const { rows } = await this.pool.query<SpawnRow>(`select ${SPAWN_COLUMNS} from ${SCHEMA}.spawns where email = $1 and world = $2`, [lower(email), world]);
    return rows[0] ? { x: rows[0].x, z: rows[0].z, locked: rows[0].locked } : null;
  }

  async setSpawn(email: string, world: string, x: number, z: number, by: string | null, locked = false): Promise<PersonalSpawn> {
    const { rows } = await this.pool.query<SpawnRow>(
      `insert into ${SCHEMA}.spawns (email, world, x, z, set_by, locked) values ($1, $2, $3, $4, $5, $6)
       on conflict (email, world) do update set x = excluded.x, z = excluded.z, set_by = excluded.set_by, locked = excluded.locked, updated_at = now()
       returning ${SPAWN_COLUMNS}`,
      [lower(email), world, x, z, by, locked],
    );
    return toSpawn(rows[0]!);
  }

  async clearSpawn(email: string, world: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(`delete from ${SCHEMA}.spawns where email = $1 and world = $2`, [lower(email), world]);
    return (rowCount ?? 0) > 0;
  }
}

type SpawnRow = { email: string; world: string; x: number; z: number; set_by: string | null; updated_at: Date; locked: boolean };
const SPAWN_COLUMNS = 'email, world, x, z, set_by, updated_at, locked';
const toSpawn = (r: SpawnRow): PersonalSpawn => ({ email: r.email, world: r.world, x: r.x, z: r.z, setBy: r.set_by, updatedAt: r.updated_at.toISOString(), locked: r.locked });

function toAccount(r: Row): Account {
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    createdAt: r.created_at.toISOString(),
    lastSignedIn: r.last_signed_in.toISOString(),
    role: isRole(r.role) ? r.role : 'builder',
    banned: r.banned_at !== null,
    muted: r.muted_at !== null,
    displayName: r.display_name,
    avatar: parseAvatar(r.avatar),
  };
}

function toInvite(r: InviteRow): Invite {
  return {
    email: r.email,
    role: isRole(r.role) ? r.role : 'builder',
    createdAt: r.created_at.toISOString(),
    invitedBy: r.invited_by,
    usedBy: r.used_by,
    usedAt: r.used_at?.toISOString() ?? null,
  };
}
