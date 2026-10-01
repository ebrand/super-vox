import { UNITS_PER_METER, formatHours } from '@super-vox/shared';
import { chartMax, compass, formatBytes, formatDuration, formatRate } from './dashboardFormat.js';
import { decodeWorldMap, renderMap, type MapData } from './worldMap.js';

/** What /api/dashboard returns (see the server's app.ts). */
interface Sample {
  t: number;
  chunks: number;
  tiles: number;
  edits: number;
  messagesIn: number;
  bytesIn: number;
  bytesOut: number;
  waterChanges: number;
  cpu: number;
  rssMB: number;
  heapMB: number;
  loopP99: number;
  players: number;
}
interface Percentiles {
  p50: number | null;
  p95: number | null;
}
interface WorldInfo {
  name: string;
  default: boolean;
  open: boolean;
  players: number;
  diskBytes: number;
  clock: { hours: number; dayMinutes: number | 'real'; frozen: boolean } | null;
  editedChunks?: number;
  edits?: number;
  cache?: { chunks: number; tiles: number; capacity: number; chunkHitRate: number | null; tileHitRate: number | null };
  generation?: { chunks: number; tiles: number; chunkMs: Percentiles; tileMs: Percentiles };
  water?: { pending: number; steps: number; changes: number };
}
interface PlayerInfo {
  id: number;
  world: string;
  connectedAt: number;
  tolerance: number | null;
  pose: { x: number; y: number; z: number; yaw: number; at: number } | null;
  chunks: number;
  tiles: number;
  edits: number;
  bytesOut: number;
}
interface Dashboard {
  now: number;
  startedAt: number;
  protocolVersion: number;
  totals: Record<string, number>;
  history: Sample[];
  worlds: WorldInfo[];
  players: PlayerInfo[];
  errors: { t: number; kind: string; message: string; world?: string }[];
}

const $ = (id: string) => document.getElementById(id)!;
const statusEl = $('status');
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

// ---- Charts: small line charts of the history, drawn on canvases.

interface Series {
  label: string;
  color: string;
  value: (s: Sample) => number;
}
interface ChartDef {
  title: string;
  series: Series[];
  /** Least top of the vertical axis. */
  floor: number;
  format: (v: number) => string;
}
const CHARTS: ChartDef[] = [
  { title: 'Sent per second', floor: 5, format: formatRate, series: [
    { label: 'chunks', color: '#58a6ff', value: (s) => s.chunks },
    { label: 'tiles', color: '#d2a8ff', value: (s) => s.tiles },
  ] },
  { title: 'Network', floor: 1024, format: (v) => `${formatBytes(v)}/s`, series: [
    { label: 'out', color: '#7ee787', value: (s) => s.bytesOut },
    { label: 'in', color: '#e3b341', value: (s) => s.bytesIn },
  ] },
  { title: 'CPU', floor: 10, format: (v) => `${v.toFixed(0)}%`, series: [{ label: 'server process', color: '#ff7b72', value: (s) => s.cpu }] },
  { title: 'Memory', floor: 64, format: (v) => `${v.toFixed(0)} MB`, series: [
    { label: 'resident', color: '#58a6ff', value: (s) => s.rssMB },
    { label: 'JS heap', color: '#79c0ff', value: (s) => s.heapMB },
  ] },
  { title: 'Event loop delay (p99)', floor: 20, format: (v) => `${v.toFixed(1)} ms`, series: [{ label: 'late by', color: '#e3b341', value: (s) => s.loopP99 }] },
  { title: 'World changes per second', floor: 2, format: formatRate, series: [
    { label: 'edits', color: '#ffa657', value: (s) => s.edits },
    { label: 'water blocks', color: '#39c5cf', value: (s) => s.waterChanges },
  ] },
];

const chartEls = CHARTS.map((def) => {
  const box = document.createElement('div');
  box.className = 'chart';
  const legend = def.series.map((s) => `<span><i style="background:${s.color}"></i>${s.label}</span>`).join('');
  box.innerHTML = `<div class="head"><span>${def.title} <span class="legend">${legend}</span></span><span class="now"></span></div><canvas></canvas>`;
  $('charts').append(box);
  return { def, now: box.querySelector('.now') as HTMLElement, canvas: box.querySelector('canvas') as HTMLCanvasElement };
});

function drawChart(c: (typeof chartEls)[number], history: Sample[], span: number): void {
  const { canvas, def } = c;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const g = canvas.getContext('2d')!;
  g.scale(dpr, dpr);
  g.clearRect(0, 0, w, h);
  const top = chartMax(history.flatMap((s) => def.series.map((x) => x.value(s))), def.floor);
  g.strokeStyle = '#262c34';
  g.lineWidth = 1;
  g.fillStyle = '#8b949e';
  g.font = '10px system-ui';
  for (const f of [0.5, 1]) {
    const y = h - f * (h - 4);
    g.beginPath();
    g.moveTo(0, y + 0.5);
    g.lineTo(w, y + 0.5);
    g.stroke();
    g.fillText(def.format(top * f), 2, y + 11);
  }
  if (history.length === 0) return;
  const t1 = history[history.length - 1]!.t, t0 = t1 - span * 1000;
  for (const s of def.series) {
    g.strokeStyle = s.color;
    g.lineWidth = 1.5;
    g.beginPath();
    history.forEach((p, i) => {
      const x = ((p.t - t0) / (t1 - t0)) * w, y = h - (Math.min(top, s.value(p)) / top) * (h - 4);
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    });
    g.stroke();
  }
  const last = history[history.length - 1]!;
  c.now.textContent = def.series.map((s) => def.format(s.value(last))).join(' · ');
}

// ---- The map of the selected world, with its players.

const mapSelect = $('map-world') as HTMLSelectElement;
const mapCanvas = $('map') as HTMLCanvasElement, marks = $('marks') as HTMLCanvasElement;
const maps = new Map<string, Promise<MapData | null>>();
let shownMap: { world: string; map: MapData } | null = null;

function loadMap(world: string): Promise<MapData | null> {
  let p = maps.get(world);
  if (!p) {
    p = fetch(`/api/world/map?width=512&world=${encodeURIComponent(world)}`)
      .then(async (r) => (r.ok ? decodeWorldMap(await r.arrayBuffer()) : null))
      .catch(() => null);
    maps.set(world, p);
  }
  return p;
}

async function showMap(world: string): Promise<void> {
  if (shownMap?.world === world) return;
  const map = await loadMap(world);
  if (!map || mapSelect.value !== world) return;
  mapCanvas.width = map.cols;
  mapCanvas.height = map.rows;
  // The world's own proportions (round worlds are twice as wide as deep).
  mapCanvas.style.aspectRatio = `${map.cols} / ${map.rows}`;
  mapCanvas.getContext('2d')!.putImageData(new ImageData(renderMap(map), map.cols, map.rows), 0, 0);
  shownMap = { world, map };
}

function drawPlayers(players: PlayerInfo[]): void {
  const dpr = window.devicePixelRatio || 1;
  const w = marks.clientWidth, h = marks.clientHeight;
  marks.width = Math.round(w * dpr);
  marks.height = Math.round(h * dpr);
  const g = marks.getContext('2d')!;
  g.scale(dpr, dpr);
  g.clearRect(0, 0, w, h);
  const m = shownMap?.map;
  if (!m) return;
  const sx = w / (m.cols * m.step), sz = h / (m.rows * m.step);
  for (const p of players) {
    if (p.world !== shownMap!.world || !p.pose) continue;
    const x = p.pose.x * sx, z = p.pose.z * sz;
    // Facing: forward is (-sin yaw, -cos yaw) in x, z.
    const fx = -Math.sin(p.pose.yaw), fz = -Math.cos(p.pose.yaw);
    g.fillStyle = '#ff5c5c';
    g.strokeStyle = '#000';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(x + fx * 9, z + fz * 9);
    g.lineTo(x - fx * 5 - fz * 5, z - fz * 5 + fx * 5);
    g.lineTo(x - fx * 5 + fz * 5, z - fz * 5 - fx * 5);
    g.closePath();
    g.fill();
    g.stroke();
    g.fillStyle = '#fff';
    g.font = '11px system-ui';
    g.fillText(`#${p.id}`, x + 8, z - 6);
  }
}

mapSelect.addEventListener('change', () => {
  shownMap = null;
  void showMap(mapSelect.value).then(() => last && drawPlayers(last.players));
});

// ---- Polling.

let last: Dashboard | null = null;

function render(d: Dashboard): void {
  const h = d.history, s = h[h.length - 1];
  $('meta').textContent = `up ${formatDuration(d.now - d.startedAt)} · protocol ${d.protocolVersion} · ${d.players.length} player${d.players.length === 1 ? '' : 's'}`;
  const tile = (label: string, value: string, sub = '') => `<div class="tile"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
  $('tiles').innerHTML = [
    tile('Players', String(d.players.length), `${d.worlds.filter((w) => w.open).length} world(s) open`),
    tile('CPU', s ? `${s.cpu.toFixed(0)}%` : '–', 'of one core'),
    tile('Memory', s ? `${s.rssMB.toFixed(0)} MB` : '–', s ? `JS heap ${s.heapMB.toFixed(0)} MB` : ''),
    tile('Event loop', s ? `${s.loopP99.toFixed(1)} ms` : '–', 'p99 delay'),
    tile('Network out', s ? `${formatBytes(s.bytesOut)}/s` : '–', `${formatBytes(d.totals.bytesOut!)} total`),
    tile('Sent', `${formatRate(d.totals.chunksOut!)} chunks`, `${formatRate(d.totals.tilesOut!)} tiles · ${formatRate(d.totals.columnsOut!)} columns`),
    tile('Edits', String(d.totals.edits), `${d.totals.editErrors} refused`),
  ].join('');
  for (const c of chartEls) drawChart(c, h, 300);

  const pct = (v: number | null | undefined) => (v === null || v === undefined ? '–' : `${(v * 100).toFixed(0)}%`);
  const ms = (p?: Percentiles) => (p && p.p50 !== null ? `${p.p50.toFixed(1)} / ${p.p95!.toFixed(1)} ms` : '–');
  $('worlds').innerHTML =
    '<tr><th>World</th><th class="num">Players</th><th>Time</th><th class="num">Edited chunks</th><th class="num">On disk</th><th class="num">Edits</th>' +
    '<th class="num">Cached chunks / tiles</th><th class="num">Hit rate (chunks / tiles)</th><th class="num">Chunk p50 / p95</th><th class="num">Tile p50 / p95</th><th class="num">Water pending</th><th class="num">Water changes</th></tr>' +
    d.worlds
      .map((w) => {
        const clock = w.clock ? `${formatHours(w.clock.hours)} <span class="badge">${w.clock.dayMinutes === 'real' ? 'real time' : `${w.clock.dayMinutes} min day`}${w.clock.frozen ? ', stopped' : ''}</span>` : '–';
        return (
          `<tr><td>${esc(w.name)}${w.default ? '<span class="badge">default</span>' : ''}<span class="badge${w.open ? ' on' : ''}">${w.open ? 'open' : 'closed'}</span></td>` +
          `<td class="num">${w.players}</td><td>${clock}</td>` +
          `<td class="num">${w.editedChunks ?? '–'}</td><td class="num">${formatBytes(w.diskBytes)}</td><td class="num">${w.edits ?? '–'}</td>` +
          `<td class="num">${w.cache ? `${w.cache.chunks} / ${w.cache.tiles} of ${w.cache.capacity}` : '–'}</td>` +
          `<td class="num">${w.cache ? `${pct(w.cache.chunkHitRate)} / ${pct(w.cache.tileHitRate)}` : '–'}</td>` +
          `<td class="num">${ms(w.generation?.chunkMs)}</td><td class="num">${ms(w.generation?.tileMs)}</td>` +
          `<td class="num">${w.water ? w.water.pending : '–'}</td><td class="num">${w.water ? w.water.changes : '–'}</td></tr>`
        );
      })
      .join('');

  // The map: the world picked, else the busiest open one, else the default.
  const names = d.worlds.map((w) => w.name);
  if ([...mapSelect.options].map((o) => o.value).join() !== names.join()) {
    const keep = mapSelect.value;
    mapSelect.innerHTML = d.worlds.map((w) => `<option value="${esc(w.name)}">${esc(w.name)} (${w.players} player${w.players === 1 ? '' : 's'})</option>`).join('');
    const busiest = [...d.worlds].sort((a, b) => b.players - a.players)[0];
    mapSelect.value = names.includes(keep) ? keep : busiest?.players ? busiest.name : (d.worlds.find((w) => w.default)?.name ?? names[0] ?? '');
  } else {
    for (const [i, w] of d.worlds.entries()) mapSelect.options[i]!.textContent = `${w.name} (${w.players} player${w.players === 1 ? '' : 's'})`;
  }
  if (mapSelect.value) void showMap(mapSelect.value).then(() => drawPlayers(d.players));
  drawPlayers(d.players);

  $('players').innerHTML = d.players.length
    ? '<tr><th class="num">#</th><th>World</th><th class="num">Position (m)</th><th>Facing</th><th class="num">Connected</th><th class="num">Chunks</th><th class="num">Tiles</th><th class="num">Edits</th><th class="num">Sent</th><th class="num">Seen</th></tr>' +
      d.players
        .map((p) => {
          const pos = p.pose ? [p.pose.x, p.pose.y, p.pose.z].map((v) => (v / UNITS_PER_METER).toFixed(0)).join(', ') : '–';
          return (
            `<tr><td class="num">${p.id}</td><td>${esc(p.world)}${p.tolerance !== null ? ` <span class="badge">tol ${p.tolerance}/16</span>` : ''}</td>` +
            `<td class="num">${pos}</td><td>${p.pose ? compass(p.pose.yaw) : '–'}</td><td class="num">${formatDuration(d.now - p.connectedAt)}</td>` +
            `<td class="num">${p.chunks}</td><td class="num">${p.tiles}</td><td class="num">${p.edits}</td><td class="num">${formatBytes(p.bytesOut)}</td>` +
            `<td class="num">${p.pose ? `${formatDuration(d.now - p.pose.at)} ago` : 'never'}</td></tr>`
          );
        })
        .join('')
    : '<tr><td class="empty">Nobody is connected.</td></tr>';

  $('errors').innerHTML = d.errors.length
    ? [...d.errors]
        .reverse()
        .map((e) => `<li><span class="when">${new Date(e.t).toLocaleTimeString()}</span><span class="kind">${esc(e.kind)}</span>${e.world ? `<span class="badge">${esc(e.world)}</span> ` : ''}${esc(e.message)}</li>`)
        .join('')
    : '<li class="empty">None.</li>';
}

async function poll(): Promise<void> {
  try {
    const res = await fetch('/api/dashboard');
    if (res.status === 403) {
      // The server says who it's for (development servers; admins where there's sign-in).
      const why = ((await res.json().catch(() => ({}))) as { error?: string }).error;
      statusEl.textContent = why ? why[0]!.toUpperCase() + why.slice(1) + '.' : 'The dashboard is not available here.';
      statusEl.className = 'bad';
      return; // no point asking again
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    last = (await res.json()) as Dashboard;
    render(last);
    statusEl.textContent = `live · ${new Date(last.now).toLocaleTimeString()}`;
    statusEl.className = 'good';
  } catch (err) {
    statusEl.textContent = `can't reach the server (${err instanceof Error ? err.message : String(err)}); retrying`;
    statusEl.className = 'bad';
  }
  setTimeout(() => void poll(), 1000);
}

window.addEventListener('resize', () => {
  if (!last) return;
  for (const c of chartEls) drawChart(c, last.history, 300);
  drawPlayers(last.players);
});
void poll();
