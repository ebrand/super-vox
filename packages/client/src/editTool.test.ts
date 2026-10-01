import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Material } from '@super-vox/shared';
import { EditTool } from './editTool.js';
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
