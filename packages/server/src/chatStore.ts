import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HISTORY_LINES, type ChatLine } from '@super-vox/shared';

/**
 * What's been said in each world (the last HISTORY_LINES, for those who join after): kept in a file
 * a world (in `dir`, beside the worlds; or in memory, `dir` null), written as it changes.
 */
export class ChatStore {
  private readonly worlds = new Map<string, ChatLine[]>();

  constructor(private readonly dir: string | null) {}

  /** World `world`'s last lines, oldest first. */
  history(world: string): ChatLine[] {
    let lines = this.worlds.get(world);
    if (!lines) {
      lines = [];
      const file = this.file(world);
      if (file && existsSync(file)) {
        try {
          const read = JSON.parse(readFileSync(file, 'utf8')) as unknown;
          if (Array.isArray(read)) lines = (read as ChatLine[]).filter((l) => l && typeof l.text === 'string' && typeof l.at === 'number').slice(-HISTORY_LINES);
        } catch {
          // (Unreadable: begun afresh.)
        }
      }
      this.worlds.set(world, lines);
    }
    return lines;
  }

  /** Keeps a line said in `world` (only what's said to everyone is kept). */
  add(world: string, line: ChatLine): void {
    if (line.kind !== 'say') return;
    const lines = this.history(world);
    lines.push(line);
    if (lines.length > HISTORY_LINES) lines.splice(0, lines.length - HISTORY_LINES);
    const file = this.file(world);
    if (!file) return;
    mkdirSync(this.dir!, { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(lines));
    renameSync(`${file}.tmp`, file);
  }

  private file(world: string): string | null {
    // (World names are safe for a file name: lower case letters, digits, - and _.)
    return this.dir ? join(this.dir, `${world}.json`) : null;
  }
}
