import './header.js';
import './fullscreen.js';
import './envBadge.js';

/**
 * Synchronize (admins): sends objects, the meshes, the animations and worlds from this environment
 * to another (see the server's sync.ts): pick the environment, look over what's different there,
 * tick what to send, Sync.
 */

type DesignStatus = 'new' | 'differs' | 'same';
interface Compare {
  target: string;
  designs: { id: string; name: string; role: string | null; status: DesignStatus; sharing: string[] }[];
  theirsOnly: { id: string; name: string; role: string | null }[];
  meshes: 'same' | 'differs';
  animations: 'same' | 'differs';
  worlds: { name: string; mode: string; editedChunks: number; status: 'new' | 'replaces'; theirEditedChunks?: number; theirDefault?: boolean }[];
}
interface Result {
  id: string;
  target: string;
  library?: { error?: string; backup?: string; designs?: Record<string, string>; meshes?: string; animations?: string };
  worlds: { name: string; ok: boolean; error?: string; replaced?: boolean; files?: number; bytes?: number }[];
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $('status'), targetEl = $<HTMLSelectElement>('target'), goEl = $<HTMLButtonElement>('go'), summaryEl = $('summary'), resultEl = $('result');

function status(text: string, kind: 'good' | 'bad' | '' = ''): void {
  statusEl.textContent = text;
  statusEl.className = kind;
}

const STATUS_TEXT: Record<DesignStatus, string> = { new: 'new there', differs: 'different there', same: 'the same there' };

/** What's ticked: object ids, the figures, world names. */
const picked = { designs: new Set<string>(), meshes: false, animations: false, worlds: new Set<string>() };
let compare: Compare | null = null;
/** A Sync click waiting for its second (see go). */
let armed = 0;
let busy = false;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
}

function badge(text: string, kind = ''): HTMLElement {
  return el('span', { className: `badge ${kind}`, textContent: text });
}

function checkbox(checked: boolean, change: (on: boolean) => void): HTMLElement {
  const box = el('input', { type: 'checkbox', checked, disabled: busy });
  box.addEventListener('change', () => {
    change(box.checked);
    armed = 0;
    renderSummary();
  });
  return el('td', { className: 'pick' }, box);
}

function render(): void {
  const c = compare;
  if (!c) return;
  const target = c.target;
  // Objects.
  const designs = $('designs');
  designs.replaceChildren(el('tr', {}, el('th'), el('th', { textContent: 'Object' }), el('th', { textContent: 'Slot' }), el('th', { textContent: `On ${target}` })));
  for (const d of c.designs) {
    const note = d.sharing.length ? el('span', { className: 'note warn', textContent: ` · shares the slot there with ${d.sharing.join(', ')}` }) : '';
    designs.append(
      el(
        'tr',
        {},
        checkbox(picked.designs.has(d.id), (on) => (on ? picked.designs.add(d.id) : picked.designs.delete(d.id))),
        el('td', {}, d.name, el('span', { className: 'note', textContent: ` ${d.id}` })),
        el('td', { className: 'dim', textContent: d.role ?? '—' }),
        el('td', {}, badge(STATUS_TEXT[d.status], d.status), note),
      ),
    );
  }
  if (!c.designs.length) designs.append(el('tr', {}, el('td', { colSpan: 4, className: 'dim', textContent: 'No objects here.' })));
  $('theirs-only').textContent = c.theirsOnly.length ? `Only on ${target} (they stay): ${c.theirsOnly.map((d) => d.name + (d.role ? ` (${d.role})` : '')).join(', ')}` : '';
  // Figures.
  const figures = $('figures');
  figures.replaceChildren(el('tr', {}, el('th'), el('th', { textContent: 'Library' }), el('th', { textContent: `On ${target}` })));
  for (const [key, name] of [['meshes', 'Meshes (players’ figures)'], ['animations', 'Animations']] as const) {
    const same = c[key] === 'same';
    figures.append(el('tr', {}, checkbox(picked[key], (on) => (picked[key] = on)), el('td', { textContent: name }), el('td', {}, badge(same ? 'the same there' : 'different there', same ? '' : 'differs'))));
  }
  // Worlds.
  const worlds = $('worlds');
  worlds.replaceChildren(el('tr', {}, el('th'), el('th', { textContent: 'World' }), el('th', { textContent: 'Mode' }), el('th', { textContent: 'Edited chunks' }), el('th', { textContent: `On ${target}` })));
  for (const w of c.worlds) {
    const there =
      w.status === 'new'
        ? badge('new there', 'new')
        : el('span', {}, badge(`replaces theirs (${w.theirEditedChunks ?? 0} edited chunks)`, 'differs'), w.theirDefault ? el('span', { className: 'note warn', textContent: ` · their default world` }) : '');
    worlds.append(el('tr', {}, checkbox(picked.worlds.has(w.name), (on) => (on ? picked.worlds.add(w.name) : picked.worlds.delete(w.name))), el('td', { textContent: w.name }), el('td', { className: 'dim', textContent: w.mode }), el('td', { className: 'dim', textContent: String(w.editedChunks) }), el('td', {}, there)));
  }
  renderSummary();
}

/** What a Sync would send, in words; and the button. */
function renderSummary(): void {
  const parts: string[] = [];
  if (picked.designs.size) parts.push(`${picked.designs.size} object${picked.designs.size === 1 ? '' : 's'}`);
  if (picked.meshes) parts.push('the meshes');
  if (picked.animations) parts.push('the animations');
  const replaced = compare?.worlds.filter((w) => picked.worlds.has(w.name) && w.status === 'replaces').length ?? 0;
  if (picked.worlds.size) parts.push(`${picked.worlds.size} world${picked.worlds.size === 1 ? '' : 's'}${replaced ? ` (replacing ${replaced} there)` : ''}`);
  const target = compare?.target ?? targetEl.value;
  goEl.disabled = busy || !parts.length || !compare;
  const waiting = armed > performance.now();
  goEl.textContent = busy ? 'Syncing…' : waiting ? `Really sync to ${target}?` : 'Sync';
  goEl.className = waiting ? 'primary armed' : 'primary';
  summaryEl.textContent = parts.length ? `${waiting ? 'Click again to send' : 'Sends'} ${parts.join(', ')} to ${target}.` : 'Nothing picked.';
}

async function loadCompare(): Promise<void> {
  const target = targetEl.value;
  if (!target) return;
  compare = null;
  for (const s of document.querySelectorAll<HTMLElement>('.pickers')) s.hidden = true;
  status(`comparing with ${target}…`);
  const res = await fetch(`/api/sync/compare?target=${encodeURIComponent(target)}`).catch(() => null);
  const body = (await res?.json().catch(() => null)) as (Compare & { error?: string }) | null;
  if (!res?.ok || !body || body.error) return status(body?.error ?? `couldn't compare (${res ? res.status : 'no server'})`, 'bad');
  compare = body;
  // (Picks kept where they still mean something: the same ids and names.)
  for (const id of picked.designs) if (!body.designs.some((d) => d.id === id)) picked.designs.delete(id);
  for (const n of picked.worlds) if (!body.worlds.some((w) => w.name === n)) picked.worlds.delete(n);
  for (const s of document.querySelectorAll<HTMLElement>('.pickers')) s.hidden = false;
  $('compared').textContent = `compared at ${new Date().toLocaleTimeString()}`;
  status('');
  render();
}

for (const b of document.querySelectorAll<HTMLButtonElement>('[data-pick]')) {
  b.addEventListener('click', () => {
    if (!compare || busy) return;
    const [, which] = b.dataset.pick!.split(':');
    picked.designs.clear();
    if (which === 'changed') for (const d of compare.designs) if (d.status !== 'same') picked.designs.add(d.id);
    armed = 0;
    render();
  });
}

goEl.addEventListener('click', async () => {
  if (!compare || busy) return;
  // (A second click within a few seconds says yes: it changes another environment.)
  if (!(armed > performance.now())) {
    armed = performance.now() + 5000;
    renderSummary();
    setTimeout(renderSummary, 5100);
    return;
  }
  armed = 0;
  busy = true;
  render();
  resultEl.replaceChildren();
  status(`syncing to ${compare.target}…`);
  const body = { target: compare.target, designs: [...picked.designs], meshes: picked.meshes, animations: picked.animations, worlds: [...picked.worlds] };
  const res = await fetch('/api/sync/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
  const r = (await res?.json().catch(() => null)) as (Result & { error?: string }) | null;
  busy = false;
  if (!res?.ok || !r || r.error) {
    status(r?.error ?? `the sync didn't run (${res ? res.status : 'no server'})`, 'bad');
    render();
    return;
  }
  // (What's there now, then what became of each: the comparing doesn't wipe it.)
  await loadCompare();
  showResult(r);
});

function showResult(r: Result): void {
  const lines: [string, boolean][] = [];
  const lib = r.library;
  if (lib?.error) lines.push([`Objects and figures: ${lib.error}`, false]);
  else if (lib) {
    for (const [id, what] of Object.entries(lib.designs ?? {})) lines.push([`${id}: ${what}`, !what.startsWith('not')]);
    if (lib.meshes) lines.push([`meshes: ${lib.meshes}`, !lib.meshes.startsWith('not')]);
    if (lib.animations) lines.push([`animations: ${lib.animations}`, !lib.animations.startsWith('not')]);
  }
  for (const w of r.worlds) lines.push(w.ok ? [`world ${w.name}: ${w.replaced ? 'replaced' : 'added'} (${w.files} files, ${((w.bytes ?? 0) / 1e6).toFixed(1)} MB)`, true] : [`world ${w.name}: ${w.error}`, false]);
  const failed = lines.filter(([, ok]) => !ok).length;
  resultEl.replaceChildren(...lines.map(([text, ok]) => el('li', { className: ok ? 'good' : 'bad', textContent: text })));
  if (lib?.backup) resultEl.append(el('li', { className: 'note', textContent: `What was replaced on ${r.target} is in its backup ${lib.backup}.` }));
  else if (r.worlds.some((w) => w.ok && w.replaced)) resultEl.append(el('li', { className: 'note', textContent: `What was replaced on ${r.target} is in its backup ${r.id}-from-….` }));
  status(failed ? `synced to ${r.target}, but ${failed} didn't go` : `synced to ${r.target}`, failed ? 'bad' : 'good');
}

targetEl.addEventListener('change', () => {
  armed = 0;
  void loadCompare();
});
$('refresh').addEventListener('click', () => void loadCompare());

async function start(): Promise<void> {
  const res = await fetch('/api/sync/targets').catch(() => null);
  if (!res?.ok) {
    const why = ((await res?.json().catch(() => null)) as { error?: string } | null)?.error;
    $('denied').textContent = why ?? "couldn't reach the server";
    $('denied').hidden = false;
    return status('');
  }
  const t = (await res.json()) as { environment: string; targets: { name: string; url: string }[]; canSend: boolean };
  $('here').textContent = t.environment;
  for (const s of document.querySelectorAll<HTMLElement>('section.admin:not(.pickers)')) s.hidden = false;
  if (!t.targets.length || !t.canSend) {
    targetEl.hidden = true;
    $('refresh').hidden = true;
    $('compared').textContent = !t.targets.length ? 'No other environments are set up to sync to (SYNC_TARGETS).' : "This server has no SYNC_SECRET: it can't send.";
    return status('');
  }
  targetEl.append(...t.targets.map((x) => new Option(`${x.name} (${x.url.replace(/^https?:\/\//, '')})`, x.name)));
  await loadCompare();
}

void start();
