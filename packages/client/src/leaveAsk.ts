/**
 * When Esc asks to leave the world. The browser takes the first Esc for itself (it frees the mouse,
 * and the page never hears the key; full-screen, it may only leave full-screen, the mouse still
 * captured), so: the mouse freed by anything but the game (E, M, L, a furnace) asks; leaving
 * full-screen with the mouse captured frees it and asks; with the mouse already free, Esc asks.
 * Another window taking over frees the mouse too: that doesn't ask. The page may be a moment
 * settling first (leaving full-screen animates, and the window has no focus meanwhile), so asking
 * waits for it, a while.
 */
export interface LeaveAskEnv {
  /** Whether the page has the focus and is showing. */
  focused(): boolean;
  /** Whether the mouse is captured. */
  locked(): boolean;
  /** Frees the mouse (exits pointer lock). */
  free(): void;
  /** Asks (shows the dialog; it's for it to do nothing if it's open already). */
  ask(): void;
  now(): number;
  later(fn: () => void, ms: number): void;
}

/** How long asking waits for the page to settle (ms), looking every STEP; then it doesn't (another window has it). */
export const SETTLE_MS = 1500;
const STEP = 50;
/** An Esc this soon after the mouse was freed is the one that freed it (ms). */
const SAME_ESC_MS = 400;

export class LeaveAsk {
  private freeing = false;
  private freedAt = -Infinity;
  /** Bumped to cancel a wait. */
  private waiting = 0;

  constructor(private readonly env: LeaveAskEnv) {}

  /** The game freeing the mouse (no asking). */
  free(): void {
    if (!this.env.locked()) return;
    this.freeing = true;
    this.env.free();
  }

  /** The mouse was captured or freed (pointerlockchange). */
  lockChanged(locked: boolean): void {
    // (Captured again: whatever was waiting to ask doesn't.)
    if (locked) {
      this.waiting++;
      return;
    }
    this.freedAt = this.env.now();
    const ours = this.freeing;
    this.freeing = false;
    if (!ours) this.askWhenSettled();
  }

  /** Full-screen began or ended (fullscreenchange). Ended with the mouse still captured: that was Esc. */
  fullscreenChanged(full: boolean): void {
    if (full) return;
    // (A moment, for the browser to let go of the mouse too, if it does.)
    this.env.later(() => {
      if (!this.env.locked()) return;
      this.free();
      this.askWhenSettled();
    }, STEP);
  }

  /** Esc pressed (and heard: the mouse was free). */
  escape(): void {
    if (this.env.locked() || this.env.now() - this.freedAt < SAME_ESC_MS) return;
    this.env.ask();
  }

  private askWhenSettled(): void {
    const id = ++this.waiting, until = this.env.now() + SETTLE_MS;
    const look = () => {
      if (id !== this.waiting || this.env.locked()) return;
      if (this.env.focused()) return this.env.ask();
      if (this.env.now() < until) this.env.later(look, STEP);
    };
    this.env.later(look, STEP);
  }
}
