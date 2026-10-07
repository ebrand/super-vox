import { describe, expect, it } from 'vitest';
import { LeaveAsk, SETTLE_MS } from './leaveAsk.js';

/** A page with a clock run by hand. */
function page() {
  let t = 0;
  const timers: { at: number; fn: () => void }[] = [];
  const p = {
    locked: true,
    focused: true,
    asked: 0,
    freed: 0,
    run(ms: number) {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        t = next.at;
        next.fn();
      }
      t = end;
    },
  };
  const ask = new LeaveAsk({
    focused: () => p.focused,
    locked: () => p.locked,
    free: () => {
      p.freed++;
      p.locked = false;
    },
    ask: () => p.asked++,
    now: () => t,
    later: (fn, ms) => timers.push({ at: t + ms, fn }),
  });
  return { p, ask };
}

describe('LeaveAsk', () => {
  it('asks when the browser frees the mouse (the first Esc), once', () => {
    const { p, ask } = page();
    p.locked = false;
    ask.lockChanged(false);
    p.run(200);
    expect(p.asked).toBe(1);
    // (The Esc that freed it, should the page hear it after all: not a second.)
    ask.escape();
    expect(p.asked).toBe(1);
  });

  it('waits for the page to settle (leaving full-screen: no focus for a moment)', () => {
    const { p, ask } = page();
    p.locked = false;
    p.focused = false;
    ask.lockChanged(false);
    p.run(700);
    expect(p.asked).toBe(0);
    p.focused = true;
    p.run(100);
    expect(p.asked).toBe(1);
  });

  it("doesn't ask when another window took the mouse (no focus back, or not for long)", () => {
    const { p, ask } = page();
    p.locked = false;
    p.focused = false;
    ask.lockChanged(false);
    p.run(SETTLE_MS + 500);
    p.focused = true;
    p.run(1000);
    expect(p.asked).toBe(0);
  });

  it("doesn't ask when the game frees the mouse (E, M, a furnace)", () => {
    const { p, ask } = page();
    ask.free();
    ask.lockChanged(false);
    p.run(500);
    expect(p.freed).toBe(1);
    expect(p.asked).toBe(0);
    // And the next time the browser frees it, it asks again.
    p.locked = true;
    ask.lockChanged(true);
    p.locked = false;
    ask.lockChanged(false);
    p.run(200);
    expect(p.asked).toBe(1);
  });

  it('asks when Esc leaves full-screen with the mouse still captured (freeing it)', () => {
    const { p, ask } = page();
    ask.fullscreenChanged(false);
    p.run(50);
    // (Freeing it: the lock change that follows is the game's.)
    expect(p.freed).toBe(1);
    ask.lockChanged(false);
    p.run(300);
    expect(p.asked).toBe(1);
  });

  it('asks once when leaving full-screen frees the mouse too', () => {
    const { p, ask } = page();
    p.locked = false;
    ask.lockChanged(false);
    ask.fullscreenChanged(false);
    p.run(500);
    expect(p.freed).toBe(0);
    expect(p.asked).toBe(1);
  });

  it('asks on Esc with the mouse already free; not while it is captured', () => {
    const { p, ask } = page();
    ask.escape();
    expect(p.asked).toBe(0);
    p.locked = false;
    ask.lockChanged(false);
    p.run(1000);
    expect(p.asked).toBe(1);
    ask.escape();
    expect(p.asked).toBe(2);
  });

  it('stops waiting once the mouse is captured again', () => {
    const { p, ask } = page();
    p.locked = false;
    p.focused = false;
    ask.lockChanged(false);
    p.run(200);
    p.locked = true;
    ask.lockChanged(true);
    p.focused = true;
    p.run(1000);
    expect(p.asked).toBe(0);
  });
});
