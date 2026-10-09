import * as THREE from 'three';
import type { Track } from '@super-vox/shared';
import { trackModel } from './trackModel.js';

/**
 * Laid track in the world (see trackModel): every track's model, made again when the world's
 * track changes, lit with the day (dark at night, as figures and boats are).
 */
export class TrackView {
  readonly group = new THREE.Group();
  private readonly material = new THREE.MeshBasicMaterial({ vertexColors: true });
  private readonly models = new Map<number, THREE.Group>();

  constructor(private readonly daylight: () => number) {}

  setTracks(tracks: readonly Track[]): void {
    const keep = new Set(tracks.map((t) => t.id));
    for (const [id, m] of this.models)
      if (!keep.has(id)) {
        this.group.remove(m);
        m.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
        this.models.delete(id);
      }
    for (const t of tracks) {
      if (this.models.has(t.id)) continue;
      const m = trackModel(t.points, this.material);
      this.models.set(t.id, m);
      this.group.add(m);
    }
  }

  frame(): void {
    this.material.color.setScalar(Math.max(0.15, this.daylight()));
  }
}
