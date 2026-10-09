import './header.js';
import './fullscreen.js';
import './envBadge.js';
import { pickSpawn, type Picked } from './spawnPicker.js';

/**
 * Players (admins): inviting people (only those invited can make an account), and everyone who
 * has one: what they may do (admin, builder, visitor), banning (signed out at once, and kept
 * out), and their own spawn points (a world each: see spawnPicker). See the server's /api/players.
 */

type Role = 'admin' | 'builder' | 'visitor';
const ROLES: readonly { role: Role; name: string }[] = [
  { role: 'builder', name: 'builder' },
  { role: 'visitor', name: 'visitor (looks only)' },
  { role: 'admin', name: 'admin' },
];
interface Player {
  id: string;
  email: string;
  name: string;
  createdAt: string;
  lastSignedIn: string;
  role: Role;
  banned: boolean;
  online: boolean;
  /** An admin by ADMIN_EMAILS (whatever their role says). */
  adminByEmail: boolean;
  /** The name they've chosen to go by (on their account page), if any. */
  displayName: string | null;
}
interface Invite {
  email: string;
  role: Role;
  createdAt: string;
  invitedBy: string | null;
  usedBy: string | null;
  usedAt: string | null;
}

interface Spawn {
  email: string;
  world: string;
  x: number;
  z: number;
  /** Not for the player to change. */
  locked: boolean;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $('status');
const status = (text: string, kind: '' | 'good' | 'bad' = '') => {
  statusEl.textContent = text;
  statusEl.className = kind;
};
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', cls = '') => {
  const e = document.createElement(tag);
  if (text) e.textContent = text;
  if (cls) e.className = cls;
  return e;
};
const row = (cells: (string | Node)[], tag: 'td' | 'th' = 'td') => {
  const tr = el('tr');
  for (const c of cells) {
    const td = el(tag);
    td.append(c);
    tr.append(td);
  }
  return tr;
};
const roleSelect = (value: Role, disabled = false) => {
  const s = el('select');
  for (const r of ROLES) s.append(new Option(r.name, r.role, false, r.role === value));
  s.disabled = disabled;
  return s;
};

let me = '';
/** The worlds there are (for spawn points), and a spawn point picked for the next invitation. */
let worlds: string[] = [];
let inviteSpawn: Picked | null = null;

/** Someone's spawn points (each: its world, where, and a ×), and Set… to add or move one. */
function spawnCell(email: string, who: string, spawns: Spawn[]): HTMLElement {
  const cell = el('span', '', 'spawns');
  for (const s of spawns.filter((x) => x.email === email.toLowerCase())) {
    const chip = el('span', `${s.world}: ${Math.round(s.x)}, ${Math.round(s.z)}`, 'badge');
    const lock = el('button', s.locked ? '🔒' : '🔓', 'clear');
    lock.title = s.locked ? "locked: they can't change it (click to let them)" : 'they can change it on their account page (click to lock it)';
    lock.onclick = () => void act(() => api('PUT', '/api/spawns', { email, world: s.world, x: s.x, z: s.z, locked: !s.locked }), s.locked ? `${who} can change where they start in ${s.world} now` : `${who}'s spawn point in ${s.world} is locked`);
    chip.append(lock);
    const clear = el('button', '×', 'clear');
    clear.title = `back to the world's own spawn point in ${s.world}`;
    clear.onclick = () => void act(() => api('DELETE', `/api/spawns/${encodeURIComponent(s.world)}/${encodeURIComponent(email)}`), `${who} starts at the world's own spawn point in ${s.world} now`);
    chip.append(clear);
    cell.append(chip);
  }
  const set = el('button', 'Set…');
  set.title = 'Where they start in a world (and come back to without a bed)';
  set.onclick = async () => {
    const mine = spawns.filter((x) => x.email === email.toLowerCase()).map((x) => ({ world: x.world, x: x.x, z: x.z }));
    const picked = await pickSpawn(who, worlds, mine);
    // (Moved: locked as it was.)
    const locked = spawns.some((x) => x.email === email.toLowerCase() && x.world === picked?.world && x.locked);
    if (picked) void act(() => api('PUT', '/api/spawns', { email, ...picked, locked }), `${who} starts in ${picked.world} at ${picked.x}, ${picked.z}`);
  };
  cell.append(set);
  return cell;
}

async function api(method: string, url: string, body?: unknown): Promise<unknown> {
  const res = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : null });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `${res.status}`);
  return data;
}

async function load(): Promise<void> {
  let data: { players: Player[]; invites: Invite[]; spawns: Spawn[] };
  try {
    data = (await api('GET', '/api/players')) as typeof data;
  } catch (err) {
    $('denied').hidden = false;
    $('denied').textContent = (err as Error).message;
    status('');
    return;
  }
  for (const s of document.querySelectorAll<HTMLElement>('.admin')) s.hidden = false;
  const names = new Map(data.players.map((p) => [p.id, p.name]));
  // Invitations.
  const invites = $('invites');
  invites.replaceChildren(row(['Email', 'As', 'Invited', 'By', 'Used', 'Spawn points', ''], 'th'));
  if (!data.invites.length) invites.append(row([el('span', 'no invitations yet', 'dim'), '', '', '', '', '', '']));
  for (const i of data.invites) {
    const take = el('button', 'Take back');
    take.disabled = !!i.usedBy;
    take.title = i.usedBy ? 'already used: manage the player below' : '';
    take.onclick = () => void act(() => api('DELETE', `/api/invites/${encodeURIComponent(i.email)}`), `took back the invitation for ${i.email}`);
    invites.append(row([i.email, i.role, when(i.createdAt), i.invitedBy ? (names.get(i.invitedBy) ?? '?') : '', i.usedBy ? `${names.get(i.usedBy) ?? 'yes'}, ${when(i.usedAt)}` : 'not yet', i.usedBy ? el('span', 'see below', 'dim') : spawnCell(i.email, i.email, data.spawns), take]));
  }
  // Players.
  const players = $('players');
  players.replaceChildren(row(['Player', 'Email', 'Role', 'Last signed in', 'Joined', 'Spawn points', ''], 'th'));
  for (const p of data.players) {
    const name = el('span', p.displayName ?? p.name);
    if (p.displayName && p.displayName !== p.name) name.append(el('span', p.name, 'badge'));
    if (p.online) name.append(el('span', 'online', 'badge on'));
    if (p.banned) name.append(el('span', 'banned', 'badge bad'));
    if (p.id === me) name.append(el('span', 'you', 'badge'));
    const role = roleSelect(p.role, p.id === me);
    const cell = el('span');
    cell.append(role);
    if (p.adminByEmail) {
      cell.append(el('span', 'admin by email', 'badge'));
      cell.title = 'An admin by ADMIN_EMAILS on the server, whatever this says.';
    }
    role.onchange = () => void act(() => api('PATCH', `/api/players/${p.id}`, { role: role.value }), `${p.name} is ${role.value === 'visitor' ? 'a visitor' : `${role.value === 'admin' ? 'an' : 'a'} ${role.value}`} now`);
    const ban = el('button', p.banned ? 'Unban' : 'Ban', p.banned ? '' : 'bad');
    ban.disabled = p.id === me;
    ban.onclick = () => {
      if (!p.banned && !confirmBan(ban, p.name)) return;
      void act(() => api('PATCH', `/api/players/${p.id}`, { banned: !p.banned }), p.banned ? `${p.name} is unbanned` : `${p.name} is banned (signed out)`);
    };
    const tr = row([name, el('span', p.email, 'dim'), cell, when(p.lastSignedIn), when(p.createdAt), spawnCell(p.email, p.displayName ?? p.name, data.spawns), ban]);
    if (p.banned) tr.className = 'banned';
    players.append(tr);
  }
  status(`${data.players.length} player${data.players.length === 1 ? '' : 's'}, ${data.invites.filter((i) => !i.usedBy).length} invitation${data.invites.filter((i) => !i.usedBy).length === 1 ? '' : 's'} waiting`);
}

/** Banning asks first: the button says so, and a second click within a few seconds bans. */
function confirmBan(button: HTMLButtonElement, name: string): boolean {
  if (button.dataset.sure) return true;
  button.dataset.sure = '1';
  button.textContent = `Ban ${name}?`;
  setTimeout(() => {
    delete button.dataset.sure;
    button.textContent = 'Ban';
  }, 4000);
  return false;
}

async function act(f: () => Promise<unknown>, done: string): Promise<void> {
  try {
    await f();
    await load();
    status(done, 'good');
  } catch (err) {
    status((err as Error).message, 'bad');
    await load();
  }
}

for (const r of ROLES) $('invite-role').append(new Option(r.name, r.role));
$<HTMLFormElement>('invite').onsubmit = (e) => {
  e.preventDefault();
  const email = $<HTMLInputElement>('invite-email').value.trim();
  const role = $<HTMLSelectElement>('invite-role').value;
  const spawn = inviteSpawn;
  void act(async () => {
    await api('POST', '/api/invites', { email, role });
    if (spawn) await api('PUT', '/api/spawns', { email, ...spawn });
  }, `invited ${email}${spawn ? `, starting in ${spawn.world} at ${spawn.x}, ${spawn.z}` : ''}: they can sign in with that Google account now`).then(() => {
    $<HTMLInputElement>('invite-email').value = '';
    showInviteSpawn(null);
  });
};
/** The invitation's spawn point, to be: picked (or not) before inviting. */
function showInviteSpawn(p: Picked | null): void {
  inviteSpawn = p;
  $('invite-spawn').textContent = p ? `Spawn: ${p.world} ${p.x}, ${p.z}` : "Spawn: the world's own";
}
$('invite-spawn').onclick = async () => {
  const email = $<HTMLInputElement>('invite-email').value.trim() || 'them';
  const was = inviteSpawn;
  const picked = await pickSpawn(email, worlds, was ? [was] : []);
  // (Not if an invitation went in the meantime: it had the one there was.)
  if (inviteSpawn === was) showInviteSpawn(picked ?? was);
};

void (async () => {
  try {
    const who = (await api('GET', '/api/auth/me')) as { signedIn: boolean; id?: string };
    me = who.id ?? '';
  } catch {
    // (No sign-in here: load says so.)
  }
  try {
    worlds = ((await api('GET', '/api/worlds')) as { worlds: { name: string }[] }).worlds.map((w) => w.name);
  } catch {
    // (None to pick from: setting a spawn point says so.)
  }
  await load();
})();
