import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { applyLook, moveDirection } from './flyControls.js';

const keys = (...k: string[]) => new Set(k);

/** The camera's forward vector for a yaw/pitch, as three.js computes it. */
function forward(yaw: number, pitch = 0): THREE.Vector3 {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
  return new THREE.Vector3(0, 0, -1).applyQuaternion(q);
}

describe('moveDirection', () => {
  it('moves forward along where the camera faces, on the ground plane', () => {
    for (const yaw of [0, 0.7, -2, Math.PI]) {
      const f = forward(yaw, 0.6); // looking down should not change horizontal movement
      const flat = new THREE.Vector3(f.x, 0, f.z).normalize();
      const m = moveDirection(yaw, keys('KeyW'));
      expect(m.distanceTo(flat)).toBeLessThan(1e-9);
      expect(moveDirection(yaw, keys('KeyS')).distanceTo(flat.clone().negate())).toBeLessThan(1e-9);
    }
  });

  it('strafes right with D, perpendicular to forward', () => {
    for (const yaw of [0, 1.1, -2.5]) {
      const d = moveDirection(yaw, keys('KeyD'));
      const f = moveDirection(yaw, keys('KeyW'));
      expect(Math.abs(d.dot(f))).toBeLessThan(1e-9);
      // Right-handed: forward x right = down... so up = right x forward.
      expect(new THREE.Vector3().crossVectors(d, f).y).toBeGreaterThan(0.99);
      expect(moveDirection(yaw, keys('KeyA')).distanceTo(d.clone().negate())).toBeLessThan(1e-9);
    }
  });

  it('rises and sinks, normalizes diagonals, and stops when nothing is held', () => {
    const up = new THREE.Vector3(0, 1, 0);
    expect(moveDirection(0, keys('Space')).distanceTo(up)).toBe(0);
    expect(moveDirection(0, keys('KeyE')).distanceTo(up)).toBe(0);
    expect(moveDirection(0, keys('KeyQ')).y).toBe(-1);
    expect(moveDirection(0, keys('KeyC')).y).toBe(-1);
    expect(moveDirection(0.3, keys('KeyW', 'KeyD', 'Space')).length()).toBeCloseTo(1, 12);
    expect(moveDirection(0.3, keys()).length()).toBe(0);
    expect(moveDirection(0.3, keys('KeyW', 'KeyS')).length()).toBe(0);
  });
});

describe('applyLook', () => {
  it('turns left when dragging left and looks up when dragging up', () => {
    const a = applyLook(0, 0, -100, -50, 0.01);
    expect(a.yaw).toBeGreaterThan(0); // positive yaw turns towards -X, i.e. left
    expect(forward(a.yaw).x).toBeLessThan(0);
    expect(a.pitch).toBeGreaterThan(0);
    expect(forward(0, a.pitch).y).toBeGreaterThan(0);
  });

  it('clamps pitch short of straight up and down', () => {
    expect(applyLook(0, 0, 0, -1e6, 0.01).pitch).toBeCloseTo((89 * Math.PI) / 180, 12);
    expect(applyLook(0, 0, 0, 1e6, 0.01).pitch).toBeCloseTo((-89 * Math.PI) / 180, 12);
  });
});
