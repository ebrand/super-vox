import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { emptyMeshLibrary, parseMeshLibrary, type MeshLibrary } from '@super-vox/shared';

/**
 * The mesh library (see shared meshes.ts): the figures as edited, one for every world on the
 * server, kept in a JSON file beside the worlds (or in memory, `file` null). None saved: as the
 * game makes them.
 */
export class MeshStore {
  private library: MeshLibrary = emptyMeshLibrary();

  constructor(private readonly file: string | null) {
    if (!file || !existsSync(file)) return;
    const lib = parseMeshLibrary(JSON.parse(readFileSync(file, 'utf8')));
    if (typeof lib === 'string') console.warn(`mesh library: ${lib}; using the figures as made`);
    else this.library = lib;
  }

  get(): MeshLibrary {
    return this.library;
  }

  /** Whether any figure's been edited (else there's nothing to send). */
  get custom(): boolean {
    return Object.keys(this.library.figures).length > 0;
  }

  /** Replaces it (checked: see parseMeshLibrary); or why it won't do. */
  put(raw: unknown): MeshLibrary | string {
    const lib = parseMeshLibrary(raw);
    if (typeof lib === 'string') return lib;
    this.library = lib;
    if (this.file) {
      if (!this.custom) {
        if (existsSync(this.file)) unlinkSync(this.file);
      } else {
        const tmp = `${this.file}.tmp`;
        writeFileSync(tmp, JSON.stringify(lib));
        renameSync(tmp, this.file);
      }
    }
    return lib;
  }
}
