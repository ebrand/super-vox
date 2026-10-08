import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { defaultAnimations, parseAnimationLibrary, type AnimationLibrary } from '@super-vox/shared';

/**
 * The animation library (see shared animations.ts): one for every world on the server, kept in a
 * JSON file beside the worlds (or in memory, `file` null). None saved: the defaults.
 */
export class AnimationStore {
  private library: AnimationLibrary = defaultAnimations();
  private saved = false;

  constructor(private readonly file: string | null) {
    if (!file || !existsSync(file)) return;
    const lib = parseAnimationLibrary(JSON.parse(readFileSync(file, 'utf8')));
    if (typeof lib === 'string') console.warn(`animation library: ${lib}; using the defaults`);
    else {
      this.library = lib;
      this.saved = true;
    }
  }

  get(): AnimationLibrary {
    return this.library;
  }

  /** Whether one's been saved (else it's the defaults: no need to send it). */
  get custom(): boolean {
    return this.saved;
  }

  /** Replaces it (checked: see parseAnimationLibrary); or why it won't do. */
  put(raw: unknown): AnimationLibrary | string {
    const lib = parseAnimationLibrary(raw);
    if (typeof lib === 'string') return lib;
    this.library = lib;
    this.saved = true;
    if (this.file) {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(lib));
      renameSync(tmp, this.file);
    }
    return lib;
  }

  /** Back to the defaults (the saved one gone). */
  reset(): AnimationLibrary {
    this.library = defaultAnimations();
    this.saved = false;
    if (this.file && existsSync(this.file)) unlinkSync(this.file);
    return this.library;
  }
}
