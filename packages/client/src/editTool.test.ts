import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { Item, Material, blockFromVoxels, blockIndex, emptyChunk } from '@super-vox/shared';
import { EditTool, sizeLabel } from './editTool.js';
import type { ChunkManager } from './chunkManager.js';

/** Key events as the tool reads them (node has no KeyboardEvent). */
function key(type: 'keydown' | 'keyup', code: string, metaKey: boolean): Event {
  return Object.assign(new Event(type), { code, metaKey, altKey: false, ctrlKey: false, repeat: false, preventDefault() {} });
}

describe('EditTool hybrid placement size', () => {
  let tool: EditTool;
  const target = { x: 0, y: 0, z: 0, size: 4 }; // a 1/4 m voxel

  beforeEach(() => {
    (globalThis as { window?: EventTarget }).window = new EventTarget();
    const chunks = { chunkAt: () => undefined } as unknown as ChunkManager;
    tool = new EditTool(new THREE.Scene(), new THREE.PerspectiveCamera(), chunks, () => {}, () => Material.Stone);
  });
  afterEach(() => {
    tool.dispose();
    delete (globalThis as { window?: EventTarget }).window;
  });

  it('matches the voxel aimed at', () => {
    expect(tool.placeSize(target)).toBe(4);
    expect(tool.placeSize({ ...target, size: 16 })).toBe(16);
    expect(tool.placeSize({ ...target, size: 5 })).toBe(4); // nearest standard size
    expect(tool.placeSize({ ...target, size: 3 })).toBe(2); // ties go to the smaller
  });

  it('takes a size chosen with Command+wheel only while Command is held', () => {
    window.dispatchEvent(key('keydown', 'MetaLeft', true));
    tool.scrollSize(-200); // wheel up: bigger
    const chosen = tool.placeSize(target);
    expect(chosen).toBeGreaterThan(4);
    // Placing again and again with Command held keeps it.
    tool.click(2, { meta: true, alt: false });
    expect(tool.placeSize(target)).toBe(chosen);
    // Letting go: back to matching the target, and the choice is gone.
    window.dispatchEvent(key('keyup', 'MetaLeft', false));
    expect(tool.placeSize(target)).toBe(4);
    window.dispatchEvent(key('keydown', 'MetaLeft', true));
    expect(tool.placeSize(target)).toBe(4);
  });

  it('says when the chosen size changes (for showing it): stepping with Command, and letting Command go', () => {
    const told: (number | null)[] = [];
    tool.onSizeChange = (size) => told.push(size);
    expect(tool.chosenSize).toBeNull(); // hybrid: matches what's aimed at
    window.dispatchEvent(key('keydown', 'MetaLeft', true));
    tool.scrollSize(-200);
    expect(told.at(-1)).toBe(tool.chosenSize);
    expect(tool.chosenSize).not.toBeNull();
    // Told each step, and only when there's something new to tell.
    const n = told.length;
    tool.update();
    expect(told.length).toBe(n);
    window.dispatchEvent(key('keyup', 'MetaLeft', false));
    expect(told.at(-1)).toBeNull();
    expect(tool.chosenSize).toBeNull();
    // In place mode, the selected size, always.
    window.dispatchEvent(key('keydown', 'Tab', false));
    window.dispatchEvent(key('keydown', 'Tab', false));
    expect(tool.mode).toBe('place');
    expect(tool.chosenSize).toBe(tool.size);
    tool.scrollSize(-200, performance.now() + 10_000);
    expect(told.at(-1)).toBe(tool.size);
  });

  it('forgets the chosen size when a click comes without Command (a key-up was missed)', () => {
    window.dispatchEvent(key('keydown', 'MetaLeft', true));
    tool.scrollSize(-200);
    tool.click(2, { meta: false, alt: false });
    window.dispatchEvent(key('keydown', 'MetaLeft', true));
    expect(tool.placeSize(target)).toBe(4);
  });
});

describe('EditTool mining (survival)', () => {
  let tool: EditTool;
  let sent: { type: string; [k: string]: unknown }[];
  let now = 0;
  /** What's in hand (nothing: a bare hand). */
  let held: number | null = null;
  const stone = emptyChunk({ cx: 0, cy: 0, cz: 0 });
  stone.blocks[blockIndex(0, 0, 0)] = { kind: 'uniform', size: 16, material: Material.Stone };

  beforeEach(() => {
    (globalThis as { window?: EventTarget }).window = new EventTarget();
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    // A 1 m block of stone at the origin; air all around it (loaded).
    const chunks = { chunkAt: (c: { cx: number; cy: number; cz: number }) => (c.cx === 0 && c.cy === 0 && c.cz === 0 ? stone : emptyChunk(c)) } as unknown as ChunkManager;
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0.5, 3, 0.5);
    camera.lookAt(0.5, 0, 0.5);
    camera.updateMatrixWorld();
    sent = [];
    held = null;
    tool = new EditTool(new THREE.Scene(), camera, chunks, (m) => sent.push(m as never), () => held);
    tool.survival = true;
  });
  afterEach(() => {
    tool.dispose();
    vi.restoreAllMocks();
    delete (globalThis as { window?: EventTarget }).window;
  });
  const edits = () => sent.filter((m) => m.type === 'edit');

  it('mines while the button is held for as long as the material takes, then takes it out once', () => {
    const progress: (number | null)[] = [];
    tool.onMiningProgress = (f) => progress.push(f);
    now = 1000;
    tool.click(0, { meta: false, alt: false });
    tool.update();
    expect(sent.filter((m) => m.type === 'mine')).toEqual([{ type: 'mine', x: 0, y: 0, z: 0 }]);
    // Stone by hand: 9 s for a 1 m block (three times its hardness: it needs a pickaxe).
    now = 9900;
    tool.update();
    expect(edits()).toEqual([]);
    expect(progress.at(-1)).toBeCloseTo(8.9 / 9, 3);
    now = 10000;
    tool.update();
    expect(edits()).toMatchObject([{ type: 'edit', edit: { op: 'remove', x: 0, y: 0, z: 0 } }]);
    expect(progress.at(-1)).toBeNull();
    // Still held, still aimed at it (the server's reply isn't in yet): not mined again, however
    // long it's held (let go and press again to retry).
    const mines = sent.filter((m) => m.type === 'mine').length;
    for (now = 10100; now <= 20000; now += 500) tool.update();
    expect(edits().length).toBe(1);
    expect(sent.filter((m) => m.type === 'mine').length).toBe(mines);
  });

  it('breaks only with a tool or a bare hand (not a sword, food or a block), outlining only what what is in hand can work on', () => {
    const outline = () => (tool as unknown as { outline: THREE.Object3D }).outline.visible;
    for (const [what, item, breaks, outlined] of [
      ['a sword', Item.StoneSword, false, false],
      ['cooked pork', Item.CookedPork, false, false],
      ['a bow', Item.Bow, false, false],
      ['a block (placed against it)', Material.Dirt, false, true],
      ['a pickaxe', Item.WoodenPickaxe, true, true],
      ['nothing', null, true, true],
    ] as const) {
      sent.length = 0;
      held = item;
      now += 100_000;
      tool.update();
      expect(outline(), what).toBe(outlined);
      tool.click(0, { meta: false, alt: false });
      tool.update();
      expect(sent.some((m) => m.type === 'mine'), what).toBe(breaks);
      tool.release(0);
    }
  });

  it('stops when the button is let go, and starts again from nothing', () => {
    now = 0;
    tool.click(0, { meta: false, alt: false });
    tool.update();
    now = 2500;
    tool.update();
    tool.release(0);
    now = 3500;
    tool.update();
    expect(edits()).toEqual([]);
    tool.click(0, { meta: false, alt: false });
    tool.update();
    now = 12000;
    tool.update();
    expect(edits()).toEqual([]);
    now = 12600;
    tool.update();
    expect(edits().length).toBe(1);
  });

  it('mines with the tool in hand (telling the server), and starts again when it changes', () => {
    held = Item.StonePickaxe;
    now = 0;
    tool.click(0, { meta: false, alt: false });
    tool.update();
    expect(sent.filter((m) => m.type === 'mine')).toEqual([{ type: 'mine', x: 0, y: 0, z: 0, tool: Item.StonePickaxe }]);
    // A wooden one instead, part way: from nothing, at its pace (stone: 1.5 s).
    now = 500;
    held = Item.WoodenPickaxe;
    tool.update();
    expect(sent.filter((m) => m.type === 'mine').at(-1)).toEqual({ type: 'mine', x: 0, y: 0, z: 0, tool: Item.WoodenPickaxe });
    now = 1900;
    tool.update();
    expect(edits()).toEqual([]);
    now = 2000;
    tool.update();
    expect(edits().length).toBe(1);
  });

  it('removes at once in creative', () => {
    tool.survival = false;
    tool.click(0, { meta: false, alt: false });
    expect(edits()).toMatchObject([{ edit: { op: 'remove', x: 0, y: 0, z: 0 } }]);
    expect(sent.some((m) => m.type === 'mine')).toBe(false);
  });

  it("a geologist's hammer taps and names what it hits, never mining it (survival or creative)", () => {
    held = Item.GeologistsHammer;
    const said = vi.spyOn(tool, 'say'), tapped: number[] = [], shown: string[] = [];
    tool.onTap = (m) => tapped.push(m);
    tool.onSay = (t) => shown.push(t);
    for (const survival of [true, false]) {
      tool.survival = survival;
      now = 0;
      tool.click(0, { meta: false, alt: false });
      now = 20_000;
      tool.update();
    }
    expect(said).toHaveBeenCalledWith('stone');
    expect(tapped).toEqual([Material.Stone, Material.Stone]);
    // (Said on screen too, not only in the info panel.)
    expect(shown).toEqual(['stone', 'stone']);
    expect(edits()).toEqual([]);
    expect(sent.some((m) => m.type === 'mine')).toBe(false);
  });
});

describe('EditTool big boxes (creative)', () => {
  let tool: EditTool;
  let sent: { type: string; [k: string]: unknown }[];
  const stone = emptyChunk({ cx: 0, cy: 0, cz: 0 });
  stone.blocks[blockIndex(0, 0, 0)] = { kind: 'uniform', size: 16, material: Material.Stone };

  beforeEach(() => {
    (globalThis as { window?: EventTarget }).window = new EventTarget();
    const chunks = { chunkAt: (c: { cx: number; cy: number; cz: number }) => (c.cx === 0 && c.cy === 0 && c.cz === 0 ? stone : emptyChunk(c)) } as unknown as ChunkManager;
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0.5, 3, 0.5);
    camera.lookAt(0.5, 0, 0.5);
    camera.updateMatrixWorld();
    sent = [];
    tool = new EditTool(new THREE.Scene(), camera, chunks, (m) => sent.push(m as never), () => Material.Planks);
  });
  afterEach(() => {
    tool.dispose();
    delete (globalThis as { window?: EventTarget }).window;
  });

  it('offers sizes up to 16 m in dig and place modes in creative only, and labels them in metres', () => {
    tool.mode = 'place';
    for (let i = 0; i < 20; i++) tool.stepSize(1, false);
    expect(tool.size).toBe(16);
    tool.bigBoxes = true;
    for (let i = 0; i < 20; i++) tool.stepSize(1, false);
    expect(tool.size).toBe(256);
    expect(sizeLabel(256)).toBe('16 m');
    expect(sizeLabel(32)).toBe('2 m');
    expect(sizeLabel(16)).toBe('1 m');
    expect(sizeLabel(4)).toBe('1/4 m');
    // Hybrid never: back to at most 1 m.
    tool.mode = 'hybrid';
    expect(tool.size).toBeLessThanOrEqual(16);
  });

  it('fills a box on the 1 m grid against the face aimed at', () => {
    tool.bigBoxes = true;
    tool.mode = 'place';
    tool.size = 64;
    tool.click(0, { meta: false, alt: false });
    // On top of the 1 m stone block at the origin (its top at y = 16), the 4 m cell around the aim.
    expect(sent.filter((m) => m.type === 'edit')).toMatchObject([{ edit: { op: 'fillBox', x: 0, y: 16, z: 0, size: 64, material: Material.Planks } }]);
  });

  it("rounds a fill box out to the 1 m grid when the face aimed at isn't on it", () => {
    // A 1/4 m voxel on top of the block (its top at y = 20), aimed at from above.
    stone.blocks[blockIndex(0, 1, 0)] = blockFromVoxels([{ x: 0, y: 0, z: 0, size: 4, material: Material.Stone }]);
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0.1, 3, 0.1);
    camera.lookAt(0.1, 0, 0.1);
    camera.updateMatrixWorld();
    const chunks = { chunkAt: (c: { cx: number; cy: number; cz: number }) => (c.cx === 0 && c.cy === 0 && c.cz === 0 ? stone : emptyChunk(c)) } as unknown as ChunkManager;
    const t = new EditTool(new THREE.Scene(), camera, chunks, (m) => sent.push(m as never), () => Material.Planks);
    t.bigBoxes = true;
    t.mode = 'place';
    t.size = 32;
    t.click(0, { meta: false, alt: false });
    expect(sent.filter((m) => m.type === 'edit')).toMatchObject([{ edit: { op: 'fillBox', x: 0, y: 32, z: 0, size: 32 } }]);
    t.dispose();
    stone.blocks[blockIndex(0, 1, 0)] = null;
  });
});

describe('EditTool breaking', () => {
  it('breaks the aimed voxel a size down with a middle click, and with Shift all the way, to 1/16 m', () => {
    (globalThis as { window?: EventTarget }).window = new EventTarget();
    const chunk = emptyChunk({ cx: 0, cy: 0, cz: 0 });
    chunk.blocks[blockIndex(0, 0, 0)] = { kind: 'uniform', size: 16, material: Material.Stone };
    const chunks = { chunkAt: (c: { cx: number; cy: number; cz: number }) => (c.cx === 0 && c.cy === 0 && c.cz === 0 ? chunk : emptyChunk(c)) } as unknown as ChunkManager;
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0.5, 3, 0.5);
    camera.lookAt(0.5, 0, 0.5);
    camera.updateMatrixWorld();
    const sent: { type: string; [k: string]: unknown }[] = [];
    const tool = new EditTool(new THREE.Scene(), camera, chunks, (m) => sent.push(m as never), () => Material.Stone);
    tool.click(1, { meta: false, alt: false });
    tool.click(1, { meta: false, alt: false, shift: true });
    expect(sent.filter((m) => m.type === 'edit').map((m) => m.edit)).toMatchObject([
      { op: 'break', x: 0, y: 0, z: 0, pieceSize: 8 },
      { op: 'break', x: 0, y: 0, z: 0, pieceSize: 1 },
    ]);
    // Already 1/16 m: nothing to send.
    chunk.blocks[blockIndex(0, 0, 0)] = blockFromVoxels([{ x: 0, y: 15, z: 0, size: 1, material: Material.Stone }]);
    const n = sent.length;
    camera.position.set(0.02, 3, 0.02);
    camera.lookAt(0.02, 0, 0.02);
    camera.updateMatrixWorld();
    tool.click(1, { meta: false, alt: false, shift: true });
    expect(sent.length).toBe(n);
    tool.dispose();
    delete (globalThis as { window?: EventTarget }).window;
  });
});

describe('EditTool placing (hybrid)', () => {
  it("says what size a click places (matching the face aimed at), and why it won't fit", () => {
    (globalThis as { window?: EventTarget }).window = new EventTarget();
    const chunk = emptyChunk({ cx: 0, cy: 0, cz: 0 });
    chunk.blocks[blockIndex(0, 0, 0)] = { kind: 'uniform', size: 16, material: Material.Stone };
    const chunks = { chunkAt: (c: { cx: number; cy: number; cz: number }) => (c.cx === 0 && c.cy === 0 && c.cz === 0 ? chunk : emptyChunk(c)) } as unknown as ChunkManager;
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0.5, 3, 0.5);
    camera.lookAt(0.5, 0, 0.5);
    camera.updateMatrixWorld();
    let held: number | null = Material.Dirt;
    const tool = new EditTool(new THREE.Scene(), camera, chunks, () => {}, () => held);
    tool.update();
    // On top of a 1 m block: 1 m, and there's room.
    expect(tool.placing).toEqual({ size: 16, why: '' });
    // Something small where it'd go: what, and how big.
    chunk.blocks[blockIndex(0, 1, 0)] = blockFromVoxels([{ x: 12, y: 0, z: 12, size: 4, material: Material.Planks }]);
    tool.update();
    expect(tool.placing).toEqual({ size: 16, why: '1/4 m of planks is in the way' });
    // Not a block in hand: nothing said.
    held = Item.StoneSword;
    tool.update();
    expect(tool.placing).toBeNull();
    tool.dispose();
    delete (globalThis as { window?: EventTarget }).window;
  });
});

describe('EditTool TNT', () => {
  it('lights TNT with a click in hybrid (and never mines it, even in survival)', () => {
    (globalThis as { window?: EventTarget }).window = new EventTarget();
    const tnt = emptyChunk({ cx: 0, cy: 0, cz: 0 });
    tnt.blocks[blockIndex(0, 0, 0)] = { kind: 'uniform', size: 16, material: Material.TNT };
    const chunks = { chunkAt: (c: { cx: number; cy: number; cz: number }) => (c.cx === 0 && c.cy === 0 && c.cz === 0 ? tnt : emptyChunk(c)) } as unknown as ChunkManager;
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0.5, 3, 0.5);
    camera.lookAt(0.5, 0, 0.5);
    camera.updateMatrixWorld();
    const sent: { type: string; [k: string]: unknown }[] = [];
    const tool = new EditTool(new THREE.Scene(), camera, chunks, (m) => sent.push(m as never), () => Material.Stone);
    tool.survival = true;
    tool.click(0, { meta: false, alt: false });
    tool.update();
    expect(sent).toMatchObject([{ type: 'ignite', x: 0, y: 0, z: 0 }]);
    expect(sent.some((m) => m.type === 'mine' || m.type === 'edit')).toBe(false);
    expect(tool.hudLines()).toContain('light it');
    tool.dispose();
    delete (globalThis as { window?: EventTarget }).window;
  });
});

describe('EditTool build mode (creative)', () => {
  let tool: EditTool;
  let camera: THREE.PerspectiveCamera;
  let sent: { type: string; [k: string]: unknown }[];
  let held: number | null;
  const stone = emptyChunk({ cx: 0, cy: 0, cz: 0 });
  stone.blocks[blockIndex(0, 0, 0)] = { kind: 'uniform', size: 16, material: Material.Stone };
  const look = (x: number, y: number, z: number) => {
    camera.lookAt(x, y, z);
    camera.updateMatrixWorld();
  };

  beforeEach(() => {
    (globalThis as { window?: EventTarget }).window = new EventTarget();
    const chunks = { chunkAt: (c: { cx: number; cy: number; cz: number }) => (c.cx === 0 && c.cy === 0 && c.cz === 0 ? stone : emptyChunk(c)) } as unknown as ChunkManager;
    camera = new THREE.PerspectiveCamera();
    camera.position.set(0.6, 3, 0.6); // (off the cells' corners: (9.6, 48, 9.6))
    look(0.6, 0, 0.6);
    sent = [];
    held = Material.Planks;
    tool = new EditTool(new THREE.Scene(), camera, chunks, (m) => sent.push(m as never), () => held);
  });
  afterEach(() => {
    tool.dispose();
    delete (globalThis as { window?: EventTarget }).window;
  });

  it('is a mode in creative only', () => {
    const modes = () => Array.from({ length: 4 }, () => (window.dispatchEvent(key('keydown', 'Tab', false)), tool.mode));
    expect(modes()).toEqual(['dig', 'place', 'hybrid', 'dig']);
    tool.mode = 'hybrid';
    tool.bigBoxes = true;
    expect(modes()).toEqual(['dig', 'place', 'build', 'hybrid']);
  });

  it('clicks out a box (base, then height) and sends it to be built; U and ⌘Z undo', () => {
    tool.bigBoxes = true;
    tool.mode = 'build';
    expect(tool.size).toBe(4); // (at most 1 m: no big boxes here)
    tool.click(0, { meta: false, alt: false }); // on top of the stone block: from (8, 16, 8)
    expect(tool.builder.active).toBe(true);
    look(1.4, 1.125, 0.6); // across the plane through the start's middle, to x 22.4
    tool.update();
    tool.click(0, { meta: false, alt: false }); // the base
    tool.click(0, { meta: false, alt: false }); // the height: none (aimed at the base)
    expect(sent).toEqual([{ type: 'build', id: expect.any(Number), op: { shape: { kind: 'box', a: { x: 8, y: 16, z: 8 }, b: { x: 20, y: 16, z: 8 } }, size: 4, material: Material.Planks, clear: false } }]);
    expect(tool.builder.active).toBe(false);
    window.dispatchEvent(key('keydown', 'KeyU', false));
    window.dispatchEvent(key('keydown', 'KeyZ', true));
    expect(sent.slice(1).map((m) => m.type)).toEqual(['undo', 'undo']);
    // The server's answer is said.
    const said: string[] = [];
    tool.onSay = (t) => said.push(t);
    tool.onServerMessage({ type: 'editResult', id: sent[0]!.id as number, ok: true, note: 'built: 4 voxels' });
    tool.onServerMessage({ type: 'editResult', id: sent[1]!.id as number, ok: false, error: 'nothing to undo' });
    expect(said).toEqual(['built: 4 voxels', 'undo failed: nothing to undo']);
  });

  it('Shift as it starts clears instead, in what was aimed at; right-click drops it; G changes the shape', () => {
    tool.bigBoxes = true;
    tool.mode = 'build';
    tool.click(0, { meta: false, alt: false, shift: true });
    tool.click(2, { meta: false, alt: false });
    expect(tool.builder.active).toBe(false);
    window.dispatchEvent(key('keydown', 'KeyG', false));
    expect(tool.builder.tool).toBe('circle');
    for (let i = 0; i < 4; i++) window.dispatchEvent(key('keydown', 'KeyG', false));
    expect(tool.builder.tool).toBe('line');
    tool.click(0, { meta: false, alt: false, shift: true });
    tool.click(0, { meta: false, alt: false });
    expect(sent).toMatchObject([{ type: 'build', op: { shape: { kind: 'box', a: { x: 8, y: 12, z: 8 }, b: { x: 8, y: 12, z: 8 } }, clear: true } }]);
  });

  it("won't build with nothing, or what isn't a block, in hand (but clears)", () => {
    tool.bigBoxes = true;
    tool.mode = 'build';
    const said: string[] = [];
    tool.onSay = (t) => said.push(t);
    held = Item.Bow;
    tool.click(0, { meta: false, alt: false });
    held = null;
    tool.click(0, { meta: false, alt: false });
    expect(tool.builder.active).toBe(false);
    expect(said).toHaveLength(2);
    tool.click(0, { meta: false, alt: false, shift: true });
    expect(tool.builder.active).toBe(true);
  });
});

describe('surfaceFaces (the build preview)', () => {
  it('keeps only the faces not against another cell, however big the box round them', async () => {
    const { surfaceFaces } = await import('./editTool.js');
    const { buildCells } = await import('@super-vox/shared');
    const box = buildCells({ shape: { kind: 'box', a: { x: 0, y: 0, z: 0 }, b: { x: 36, y: 36, z: 36 } }, size: 4, material: Material.Stone, clear: false }) as { x: number; y: number; z: number }[];
    expect(box).toHaveLength(1000);
    const faces = surfaceFaces(box, 4, [0, 0, 0], [36, 36, 36], 1e6)!;
    expect(faces.length / 18).toBe(6 * 100);
    // All on the box's outside: every corner on a side of 0..40.
    for (let i = 0; i < faces.length; i += 3) expect([faces[i], faces[i + 1], faces[i + 2]].some((v) => v === 0 || v === 40)).toBe(true);
    expect(surfaceFaces(box, 4, [0, 0, 0], [36, 36, 36], 599)).toBeNull(); // too many
    // One cell: its six faces, a unit cube of `size` from lo.
    const one = surfaceFaces([{ x: 100, y: 200, z: 300 }], 2, [100, 200, 300], [100, 200, 300], 10)!;
    expect(one.length / 18).toBe(6);
    expect(Math.max(...one)).toBe(2);
    expect(Math.min(...one)).toBe(0);
    // A shell 64 m across of 1/4 m cells (the grid'd be too big: a set instead).
    const shell = buildCells({ shape: { kind: 'round', spec: { kind: 'sphere', centre: { x: 2, y: 2, z: 2 }, axis: 1, sign: 1, outer: 510, thickness: 4 } }, size: 4, material: Material.Stone, clear: false });
    const cells = shell as { x: number; y: number; z: number }[];
    const lo = [0, 1, 2].map((a) => cells.reduce((m, c) => Math.min(m, [c.x, c.y, c.z][a]!), Infinity));
    const hi = [0, 1, 2].map((a) => cells.reduce((m, c) => Math.max(m, [c.x, c.y, c.z][a]!), -Infinity));
    expect(surfaceFaces(cells, 4, lo, hi, 2e6)!.length).toBeGreaterThan(cells.length * 18);
  });
});

describe('extrudeFaces (the extrude preview)', () => {
  /** The rectangles of a preview, each as its six corners' min and max (units). */
  const rects = (f: Float32Array) => {
    const out: { lo: number[]; hi: number[] }[] = [];
    for (let i = 0; i < f.length; i += 18) {
      const pts = [0, 1, 2, 3, 4, 5].map((j) => [f[i + j * 3]!, f[i + j * 3 + 1]!, f[i + j * 3 + 2]!]);
      out.push({ lo: [0, 1, 2].map((a) => Math.min(...pts.map((p) => p[a]!))), hi: [0, 1, 2].map((a) => Math.max(...pts.map((p) => p[a]!))) });
    }
    return out;
  };
  it('draws each column as a box, without the walls between columns as tall', async () => {
    const { extrudeFaces } = await import('./editTool.js');
    // One 1 m voxel at (0, 0, 0), its top (y = 16) grown 2 m: a box 16 x 32 x 16 on top of it.
    const one = rects(extrudeFaces([{ x: 0, y: 0, z: 0, size: 16 }], 1, 1, 1, () => 32, [0, 0, 0], 100)!);
    expect(one).toHaveLength(6);
    expect(one.map((r) => r.lo[1])).toContain(16);
    expect(Math.max(...one.map((r) => r.hi[1]!))).toBe(48);
    expect(one.every((r) => r.lo[0]! >= 0 && r.hi[0]! <= 16 && r.lo[2]! >= 0 && r.hi[2]! <= 16)).toBe(true);
    // Two side by side (x), as tall: 2 x 2 caps, and 6 outside walls (none between them).
    const two = rects(extrudeFaces([{ x: 0, y: 0, z: 0, size: 16 }, { x: 16, y: 0, z: 0, size: 16 }], 1, 1, 1, () => 16, [0, 0, 0], 100)!);
    expect(two).toHaveLength(10);
    expect(two.some((r) => r.lo[0] === 16 && r.hi[0] === 16)).toBe(false);
    // A 1/4 m voxel beside a 1 m one, the 1 m one taller: its wall above the small one's top.
    const mixed = rects(extrudeFaces([{ x: 0, y: 0, z: 0, size: 16 }, { x: 16, y: 12, z: 0, size: 4 }], 1, 1, 1, (v) => (v.size === 16 ? 32 : 8), [0, 0, 0], 100)!);
    const between = mixed.filter((r) => r.lo[0] === 16 && r.hi[0] === 16);
    expect(between.find((r) => r.lo[2] === 0 && r.hi[2] === 4)).toMatchObject({ lo: [16, 24, 0], hi: [16, 48, 4] });
    expect(between.find((r) => r.lo[2] === 4)).toMatchObject({ lo: [16, 16, 4], hi: [16, 48, 8] });
    // Cut back: into the voxel. Not grown: its face, lit, a hair out. Too many: null.
    const cut = rects(extrudeFaces([{ x: 0, y: 0, z: 0, size: 16 }], 1, 1, -1, () => 8, [0, 0, 0], 100)!);
    expect(Math.min(...cut.map((r) => r.lo[1]!))).toBe(8);
    expect(Math.max(...cut.map((r) => r.hi[1]!))).toBe(16);
    const lit = rects(extrudeFaces([{ x: 0, y: 0, z: 0, size: 16 }], 1, 1, 1, () => 0, [0, 0, 0], 100)!);
    expect(lit).toHaveLength(1);
    expect(lit[0]!.lo[1]).toBeCloseTo(16.1, 5);
    expect([lit[0]!.lo[0], lit[0]!.hi[0], lit[0]!.lo[2], lit[0]!.hi[2], lit[0]!.hi[1]! - lit[0]!.lo[1]!]).toEqual([0, 16, 0, 16, 0]);
    expect(extrudeFaces([{ x: 0, y: 0, z: 0, size: 16 }], 1, 1, 1, () => 16, [0, 0, 0], 3)).toBeNull();
  });
});
