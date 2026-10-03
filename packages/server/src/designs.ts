import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { FIRST_DESIGN_ITEM, parseDesign, setDesigns, type ObjectDesign } from '@super-vox/shared';

/** The library as kept on disk: the designs, and the next item number (never reused, so old items don't become new things). */
interface LibraryFile {
  designs: unknown[];
  nextItem: number;
}

/** A design no longer standing in for anything. */
function withoutRole(d: ObjectDesign): ObjectDesign {
  const { role: _, ...rest } = d;
  return rest;
}

/**
 * The library of designed objects (see shared designs.ts): one for every world on the server, kept
 * in a JSON file beside the worlds (or in memory, `file` null). Whatever it holds is in play
 * (setDesigns) from when it's opened.
 */
export class DesignLibrary {
  private designs: ObjectDesign[] = [];
  private nextItem = FIRST_DESIGN_ITEM;

  constructor(private readonly file: string | null) {
    if (file && existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as LibraryFile;
      for (const d of raw.designs ?? []) {
        const parsed = parseDesign(d);
        if (typeof parsed === 'string') console.warn(`design library: skipping ${(d as { id?: string })?.id ?? '?'}: ${parsed}`);
        else this.designs.push(parsed);
      }
      this.nextItem = Math.max(raw.nextItem ?? FIRST_DESIGN_ITEM, ...this.designs.map((d) => d.item + 1));
    }
    setDesigns(this.designs);
  }

  list(): ObjectDesign[] {
    return this.designs;
  }

  get(id: string): ObjectDesign | undefined {
    return this.designs.find((d) => d.id === id);
  }

  /**
   * Adds a design, or replaces the one with its id (keeping its item number; a new one gets the
   * next). Returns it as kept, or why it can't be (see parseDesign).
   */
  put(raw: unknown): ObjectDesign | string {
    if (typeof raw !== 'object' || raw === null) return 'not a design';
    const id = (raw as { id?: unknown }).id;
    const old = typeof id === 'string' ? this.get(id) : undefined;
    const design = parseDesign({ ...raw, item: old?.item ?? this.nextItem });
    if (typeof design === 'string') return design;
    if (!old) this.nextItem++;
    // (One design at most stands in for each thing: the newest takes it.)
    const others = design.role ? this.designs.map((d) => (d.role === design.role ? withoutRole(d) : d)) : this.designs;
    this.designs = old ? others.map((d) => (d.id === old.id ? design : d)) : [...others, design];
    this.save();
    return design;
  }

  /** Takes a design out of the library (placed ones stay where they are; their items stop working). False if there's none. */
  delete(id: string): boolean {
    const before = this.designs.length;
    this.designs = this.designs.filter((d) => d.id !== id);
    if (this.designs.length === before) return false;
    this.save();
    return true;
  }

  private save(): void {
    setDesigns(this.designs);
    if (!this.file) return;
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ designs: this.designs, nextItem: this.nextItem } satisfies LibraryFile));
    renameSync(tmp, this.file);
  }
}
