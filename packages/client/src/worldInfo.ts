/** A world as /api/worlds lists it (see the server's WorldSummary), and how pages describe it. */
export interface WorldSummary {
  name: string;
  createdAt: string;
  updatedAt?: string;
  mode?: 'survival' | 'creative';
  /** Saved edited chunks, and terraforming strokes applied. */
  editedChunks?: number;
  strokes?: number;
  /** When its picture was set (ms), if it has one. */
  pictureAt?: number;
  spec: {
    generator: string;
    shape?: string;
    plates?: { landPercent: number; majorPlates: number; minorPlates: number; minHeight: number; maxHeight: number };
  };
}

/** What /api/worlds says: the worlds, the default, and what this visitor may do with them. */
export interface WorldList {
  default: string;
  canCreate?: boolean;
  canTerraform?: boolean;
  canPicture?: boolean;
  worlds: WorldSummary[];
}

/** A world in a line: "Creative · round-16x8 · 30% land · 7 major + 15 minor plates · -300..300 m · created 10/5/2026". */
export function describeWorld(w: WorldSummary, opts: { mode?: boolean; created?: boolean } = {}): string {
  const p = w.spec.plates;
  const created = new Date(w.createdAt);
  const when = opts.created === false || Number.isNaN(created.getTime()) ? '' : ` · created ${created.toLocaleDateString()}`;
  const mode = opts.mode !== false && w.mode ? `${w.mode[0]!.toUpperCase()}${w.mode.slice(1)} · ` : '';
  const shape = w.spec.shape ? `${w.spec.shape} · ` : '';
  if (!p) return `${mode}${shape}${w.spec.generator} terrain${when}`;
  return `${mode}${shape}${p.landPercent}% land · ${p.majorPlates} major + ${p.minorPlates} minor plates · ${p.minHeight}..${p.maxHeight} m${when}`;
}
