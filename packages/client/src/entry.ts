import { SETTINGS_LIMITS, workersFor, defaultSettings, loadSettings, saveSettings, type Performance, type Settings } from './settings.js';

/** The entry page: pick a world, play it, change settings, or open the world generator. */

interface WorldInfo {
  name: string;
  createdAt: string;
  spec: {
    generator: string;
    plates?: { landPercent: number; majorPlates: number; minorPlates: number; minHeight: number; maxHeight: number };
  };
}

const worldEl = document.getElementById('world') as HTMLSelectElement;
const aboutEl = document.getElementById('about')!;
const playEl = document.getElementById('play') as HTMLButtonElement;
const summaryEl = document.getElementById('summary')!;
const statusEl = document.getElementById('status')!;

let settings = loadSettings();
let worlds: WorldInfo[] = [];
let defaultWorld = '';

function status(text: string, kind: 'good' | 'bad' | '' = ''): void {
  statusEl.textContent = text;
  statusEl.className = kind;
}

const toleranceText = (t: number | null) => (t === null ? "world's own" : `${t}/16 m`);

function showSummary(): void {
  summaryEl.textContent = `detail ${settings.detail} chunks (${settings.detail * 16} m) · view ${settings.view} m · performance ${settings.performance} (${workersFor(settings.performance, navigator.hardwareConcurrency || 0)} mesh workers) · tolerance ${toleranceText(settings.tolerance)}`;
}

function describe(w: WorldInfo): string {
  const p = w.spec.plates;
  const created = new Date(w.createdAt);
  const when = Number.isNaN(created.getTime()) ? '' : ` · created ${created.toLocaleDateString()}`;
  if (!p) return `${w.spec.generator} terrain${when}`;
  return `${p.landPercent}% land · ${p.majorPlates} major + ${p.minorPlates} minor plates · ${p.minHeight}..${p.maxHeight} m${when}`;
}

function showWorld(): void {
  const w = worlds.find((x) => x.name === worldEl.value);
  aboutEl.textContent = w ? describe(w) : '';
}

async function loadWorlds(): Promise<void> {
  try {
    const res = await fetch('/api/worlds');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { default: string; worlds: WorldInfo[] };
    worlds = data.worlds;
    defaultWorld = data.default;
  } catch (err) {
    worldEl.innerHTML = '<option>unavailable</option>';
    status(`Couldn't reach the server (${(err as Error).message}). Is it running?`, 'bad');
    return;
  }
  worldEl.innerHTML = '';
  for (const w of worlds) {
    const opt = document.createElement('option');
    opt.value = w.name;
    opt.textContent = w.name + (w.name === defaultWorld ? ' (default)' : '');
    worldEl.appendChild(opt);
  }
  if (worlds.length === 0) {
    worldEl.innerHTML = '<option>no worlds yet</option>';
    status('No worlds yet: make one in the world generator.');
    return;
  }
  // The world picked last time, if it still exists; otherwise the server's default.
  const pick = worlds.some((w) => w.name === settings.world) ? settings.world! : defaultWorld;
  if (worlds.some((w) => w.name === pick)) worldEl.value = pick;
  worldEl.disabled = false;
  playEl.disabled = false;
  showWorld();
}

worldEl.addEventListener('change', () => {
  settings = { ...settings, world: worldEl.value };
  saveSettings(settings);
  showWorld();
});

playEl.addEventListener('click', () => {
  settings = { ...settings, world: worldEl.value };
  saveSettings(settings);
  location.href = `/play.html?world=${encodeURIComponent(worldEl.value)}`;
});

// ---- Settings dialog

const dialog = document.getElementById('settings') as HTMLDialogElement;
const form = document.getElementById('settings-form') as HTMLFormElement;
const detailEl = document.getElementById('s-detail') as HTMLInputElement;
const detailRange = document.getElementById('s-detail-range') as HTMLInputElement;
const detailHint = document.getElementById('s-detail-hint')!;
const viewEl = document.getElementById('s-view') as HTMLInputElement;
const viewRange = document.getElementById('s-view-range') as HTMLInputElement;
const toleranceEl = document.getElementById('s-tolerance') as HTMLSelectElement;
const performanceEl = document.getElementById('s-performance') as HTMLSelectElement;
const performanceHint = document.getElementById('s-performance-hint')!;
const errorEl = document.getElementById('s-error')!;

toleranceEl.appendChild(new Option("World's own", ''));
for (let t = 0; t <= 16; t++) toleranceEl.appendChild(new Option(`${t}/16 m${t === 0 ? ' (exact)' : t === 16 ? ' (1 m)' : ''}`, String(t)));

/** Keeps a slider and its number box in step. */
function pair(range: HTMLInputElement, box: HTMLInputElement, onChange: () => void): void {
  range.addEventListener('input', () => {
    box.value = range.value;
    onChange();
  });
  box.addEventListener('input', () => {
    if (box.value !== '') range.value = box.value;
    onChange();
  });
}
const detailText = () => {
  const n = Number(detailEl.value);
  detailHint.textContent = `Radius of full-detail voxel terrain around you: ${Number.isFinite(n) ? n * 16 : '?'} m (16 m per chunk). Higher costs memory and loading time.`;
};
pair(detailRange, detailEl, detailText);
pair(viewRange, viewEl, () => {});
const cores = navigator.hardwareConcurrency || 0;
if (cores) performanceHint.textContent += ` This computer has ${cores} cores.`;
for (const o of performanceEl.options) o.textContent += ` (${workersFor(o.value as Performance, cores)} mesh worker${workersFor(o.value as Performance, cores) === 1 ? '' : 's'})`;

function fillForm(s: Settings): void {
  detailEl.value = detailRange.value = String(s.detail);
  viewEl.value = viewRange.value = String(s.view);
  toleranceEl.value = s.tolerance === null ? '' : String(s.tolerance);
  performanceEl.value = s.performance;
  detailText();
}

function readForm(): Settings | string {
  const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, Math.round(v)));
  const detail = Number(detailEl.value), view = Number(viewEl.value);
  if (detailEl.value === '' || !Number.isFinite(detail)) return 'Detail distance must be a number.';
  if (viewEl.value === '' || !Number.isFinite(view)) return 'View distance must be a number.';
  return {
    ...settings,
    detail: clamp(detail, SETTINGS_LIMITS.detail),
    view: clamp(view, SETTINGS_LIMITS.view),
    tolerance: toleranceEl.value === '' ? null : Number(toleranceEl.value),
    performance: performanceEl.value as Performance,
  };
}

document.getElementById('open-settings')!.addEventListener('click', () => {
  fillForm(settings);
  errorEl.textContent = '';
  status('');
  dialog.showModal();
});
document.getElementById('s-cancel')!.addEventListener('click', () => dialog.close());
document.getElementById('s-reset')!.addEventListener('click', () => fillForm({ ...defaultSettings(), world: settings.world }));
form.addEventListener('submit', (e) => {
  const next = readForm();
  if (typeof next === 'string') {
    e.preventDefault();
    errorEl.textContent = next;
    return;
  }
  settings = next;
  const saved = saveSettings(settings);
  showSummary();
  status(saved ? 'Settings saved.' : "This browser won't store settings (site storage is blocked), so the game will use the defaults.", saved ? 'good' : 'bad');
});

showSummary();
void loadWorlds();

/** Who is signed in (the server says, from its session cookie); hidden on servers without sign-in. */
async function showAccount(): Promise<void> {
  const el = document.getElementById('account')!;
  let me: { signedIn: boolean; name?: string; email?: string; admin?: boolean };
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) return; // no sign-in here
    me = (await res.json()) as typeof me;
  } catch {
    return;
  }
  el.hidden = false;
  el.replaceChildren();
  const who = document.createElement('span');
  who.className = 'who';
  if (me.signedIn) {
    who.append('Signed in as ');
    const b = document.createElement('b');
    b.textContent = me.name ?? '';
    who.append(b);
    if (me.admin) who.append(' (admin)');
    who.title = me.email ?? '';
    const out = document.createElement('button');
    out.type = 'button';
    out.textContent = 'Sign out';
    out.addEventListener('click', () => {
      void fetch('/api/auth/logout', { method: 'POST' }).then(() => showAccount());
    });
    el.append(who, out);
  } else {
    who.textContent = 'Sign in to build; anyone can look around.';
    const signIn = document.createElement('a');
    signIn.className = 'button';
    signIn.href = '/api/auth/google?return=/';
    signIn.textContent = 'Sign in with Google';
    el.append(who, signIn);
  }
  const params = new URLSearchParams(location.search);
  if (params.get('signin') === 'cancelled') status('Sign-in cancelled.', 'bad');
}

void showAccount();

