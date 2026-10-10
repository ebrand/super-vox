import type { Track } from '@super-vox/shared';
import type { WorldMapOverlay } from './worldMap.js';

/** Laid track on the world map (M): dark rails on a pale bed. */
export class TrackMap {
  private tracks: readonly Track[] = [];

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
    };
  }

  setTracks(tracks: readonly Track[]): void {
    this.tracks = tracks;
    if (this.map.isOpen) this.map.update();
  }
}
