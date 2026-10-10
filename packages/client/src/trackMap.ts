import type { Track, TradingPost, Village } from '@super-vox/shared';
import type { WorldMapOverlay } from './worldMap.js';

/** Laid track on the world map (M), dark rails on a pale bed; and the trading posts, gold, named. */
export class TrackMap {
  private tracks: readonly Track[] = [];
  private posts: readonly TradingPost[] = [];
  private villages: readonly Village[] = [];
  private stations: readonly { id: number; name: string; x: number; z: number }[] = [];
  private picking: readonly number[] = [];

  constructor(private readonly map: WorldMapOverlay) {
    map.drawMore = (g, toX, toZ, near, dpr) => {
      for (const t of this.tracks) {
        const pts = t.points;
        if (pts.length < 2) continue;
        const x0 = near(pts[0]!.x) - pts[0]!.x;
        for (const [colour, width] of [['rgba(220, 210, 190, 0.9)', 4], ['rgba(40, 40, 44, 0.95)', 1.6]] as const) {
          g.strokeStyle = colour;
          g.lineWidth = width * dpr;
          g.beginPath();
          pts.forEach((p, i) => (i ? g.lineTo(toX(p.x + x0), toZ(p.z)) : g.moveTo(toX(p.x + x0), toZ(p.z))));
          g.stroke();
        }
      }
      g.font = `${11 * dpr}px system-ui, sans-serif`;
      g.textAlign = 'left';
      g.textBaseline = 'middle';
      // Stations: blue squares, named; those of a line being made, numbered in order.
      for (const s of this.stations) {
        const x = toX(near(s.x)), z = toZ(s.z), r = 4.5 * dpr, k = this.picking.indexOf(s.id);
        g.fillStyle = k >= 0 ? '#ffd23f' : '#58a6ff';
        g.strokeStyle = '#000';
        g.lineWidth = 1.5 * dpr;
        g.fillRect(x - r, z - r, 2 * r, 2 * r);
        g.strokeRect(x - r, z - r, 2 * r, 2 * r);
        const label = k >= 0 ? `${this.picking.map((id, i) => (id === s.id ? i + 1 : 0)).filter(Boolean).join(', ')}. ${s.name}` : s.name;
        g.lineWidth = 3 * dpr;
        g.strokeText(label, x + r + 3 * dpr, z);
        g.fillStyle = '#fff';
        g.fillText(label, x + r + 3 * dpr, z);
      }
      // Villages: a green house, named.
      for (const v of this.villages) {
        const x = toX(near(v.x)), z = toZ(v.z), r = 5 * dpr;
        g.fillStyle = '#3fb950';
        g.strokeStyle = '#000';
        g.lineWidth = 1.5 * dpr;
        g.beginPath();
        g.moveTo(x - r, z + r * 0.8);
        g.lineTo(x - r, z - r * 0.1);
        g.lineTo(x, z - r);
        g.lineTo(x + r, z - r * 0.1);
        g.lineTo(x + r, z + r * 0.8);
        g.closePath();
        g.fill();
        g.stroke();
        g.lineWidth = 3 * dpr;
        g.strokeText(v.name, x + r + 3 * dpr, z);
        g.fillStyle = '#fff';
        g.fillText(v.name, x + r + 3 * dpr, z);
      }
      for (const p of this.posts) {
        const x = toX(near(p.x)), z = toZ(p.z), r = 5 * dpr;
        g.fillStyle = '#ffd23f';
        g.strokeStyle = '#000';
        g.lineWidth = 1.5 * dpr;
        g.beginPath();
        g.moveTo(x, z - r);
        g.lineTo(x + r, z);
        g.lineTo(x, z + r);
        g.lineTo(x - r, z);
        g.closePath();
        g.fill();
        g.stroke();
        g.lineWidth = 3 * dpr;
        g.strokeText(p.name, x + r + 3 * dpr, z);
        g.fillStyle = '#fff';
        g.fillText(p.name, x + r + 3 * dpr, z);
      }
    };
  }

  setStations(stations: readonly { id: number; name: string; x: number; z: number }[], picking: readonly number[] = this.picking): void {
    this.stations = stations;
    this.picking = picking;
    if (this.map.isOpen) this.map.update();
  }

  setVillages(villages: readonly Village[]): void {
    this.villages = villages;
    if (this.map.isOpen) this.map.update();
  }

  setPosts(posts: readonly TradingPost[]): void {
    this.posts = posts;
    if (this.map.isOpen) this.map.update();
  }

  setTracks(tracks: readonly Track[]): void {
    this.tracks = tracks;
    if (this.map.isOpen) this.map.update();
  }
}
