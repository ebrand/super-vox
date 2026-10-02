import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { Material, blockFromVoxels, blockIndex, emptyChunk } from '@super-vox/shared';
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
    tool = new EditTool(new THREE.Scene(), camera, chunks, (m) => sent.push(m as never), () => Material.Stone);
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
    // Stone: 3 s for a 1 m block.
    now = 3900;
    tool.update();
    expect(edits()).toEqual([]);
    expect(progress.at(-1)).toBeCloseTo(0.9667, 3);
    now = 4000;
    tool.update();
    expect(edits()).toMatchObject([{ type: 'edit', edit: { op: 'remove', x: 0, y: 0, z: 0 } }]);
    expect(progress.at(-1)).toBeNull();
    // Still held, still aimed at it (the server's reply isn't in yet): not mined again, however
    // long it's held (let go and press again to retry).
    const mines = sent.filter((m) => m.type === 'mine').length;
    for (now = 4100; now <= 12000; now += 500) tool.update();
    expect(edits().length).toBe(1);
    expect(sent.filter((m) => m.type === 'mine').length).toBe(mines);
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
    now = 6000;
    tool.update();
    expect(edits()).toEqual([]);
    now = 6600;
    tool.update();
    expect(edits().length).toBe(1);
  });

  it('removes at once in creative', () => {
    tool.survival = false;
    tool.click(0, { meta: false, alt: false });
    expect(edits()).toMatchObject([{ edit: { op: 'remove', x: 0, y: 0, z: 0 } }]);
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
