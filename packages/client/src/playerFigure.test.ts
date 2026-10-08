import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { PlayerAct } from '@super-vox/shared';
import { FIGURE_HEIGHT, JOINTS, MAN, PlayerFigure, figureModel, playerColor, poseFor, type FigureState } from './playerFigure.js';
import { FigureMotion } from './entities.js';

const still: FigureState = { time: 0, stride: 0, speed: 0, airborne: false, swimming: false, flying: false, mining: false, swing: null, draw: null, pitch: 0 };
/** Where a joint is (m) in the posed figure. */
function at(f: PlayerFigure, joint: string): THREE.Vector3 {
  f.root.updateMatrixWorld(true);
  return f.joints.get(joint as never)!.getWorldPosition(new THREE.Vector3());
}

describe('PlayerFigure', () => {
  it('stands 1.8 m tall, feet on the ground, facing -z', () => {
    const f = new PlayerFigure(0xffffff);
    f.pose(poseFor(still));
    const box = new THREE.Box3().setFromObject(f.root);
    expect(box.min.y).toBeCloseTo(0, 1);
    expect(box.max.y).toBeCloseTo(FIGURE_HEIGHT, 1);
    // Toes forward: the feet reach further toward -z than the heels go +z.
    const foot = new THREE.Box3().setFromObject(f.joints.get('ankleL')!);
    expect(-foot.min.z).toBeGreaterThan(foot.max.z);
    expect(JOINTS).toHaveLength(17);
  });

  it("is made of the man's pieces, each on its joint (the ground plane left out); a piece not named is an error", () => {
    const m = figureModel(MAN);
    expect([...m.parts.keys()]).toEqual(JOINTS);
    // The knees turn about their balls, at about a quarter of the height; the shoulders about four fifths.
    expect(m.pivots.get('kneeL')!.y / FIGURE_HEIGHT).toBeGreaterThan(0.2);
    expect(m.pivots.get('kneeL')!.y / FIGURE_HEIGHT).toBeLessThan(0.35);
    expect(m.pivots.get('shoulderR')!.y / FIGURE_HEIGHT).toBeGreaterThan(0.72);
    // Left at -x (facing -z), right at +x.
    expect(m.pivots.get('shoulderL')!.x).toBeLessThan(0);
    expect(m.pivots.get('shoulderR')!.x).toBeGreaterThan(0);
    expect(() => figureModel({ ...MAN, parts: { ...MAN.parts, Cube: undefined as never } })).toThrow(/Cube/);
  });

  it('walks: legs swing opposite, arms against them; running leans forward', () => {
    const walk = poseFor({ ...still, speed: 1.4, stride: Math.PI / 2 });
    expect(walk.joints.legL![0]).toBeGreaterThan(0.3);
    expect(walk.joints.legR![0]).toBeLessThan(-0.3);
    expect(walk.joints.shoulderL![0]).toBeLessThan(0);
    expect(walk.joints.shoulderR![0]).toBeGreaterThan(0);
    expect(walk.lean).toBeCloseTo(0, 5);
    const run = poseFor({ ...still, speed: 7, stride: Math.PI / 2 });
    expect(run.joints.legL![0]).toBeGreaterThan(walk.joints.legL![0]);
    expect(run.lean).toBeLessThan(-0.15);
    // Standing: legs straight down.
    expect(poseFor(still).joints.legL?.[0] ?? 0).toBeCloseTo(0, 5);
  });

  it('digs with the right arm, holds a bow out where it looks and draws it back', () => {
    const up = poseFor({ ...still, swing: 0.35 });
    expect(up.joints.shoulderR![0]).toBeGreaterThan(2.5); // over the shoulder
    const down = poseFor({ ...still, swing: 0.99 });
    expect(down.joints.shoulderR![0]).toBeLessThan(0.5);
    const bow = poseFor({ ...still, draw: 1, pitch: 0.3 });
    expect(bow.joints.shoulderL![0]).toBeCloseTo(Math.PI / 2 + 0.3, 5);
    expect(bow.joints.elbowR![0]).toBeGreaterThan(poseFor({ ...still, draw: 0, pitch: 0.3 }).joints.elbowR![0]);
    // Its left hand out in front at shoulder height (looking level).
    const f = new PlayerFigure(0xffffff);
    f.pose(poseFor({ ...still, draw: 1 }));
    const hand = at(f, 'wristL'), shoulder = at(f, 'shoulderL');
    expect(hand.z).toBeLessThan(shoulder.z - 0.5);
    expect(Math.abs(hand.y - shoulder.y)).toBeLessThan(0.1);
    expect(Math.abs(hand.x - shoulder.x)).toBeLessThan(0.08); // straight ahead, not off to the side
    // The drawing hand back by the face at full draw; out at the string (in front) undrawn.
    expect(at(f, 'wristR').distanceTo(at(f, 'head'))).toBeLessThan(0.15);
    f.pose(poseFor({ ...still, draw: 0 }));
    expect(at(f, 'wristR').z).toBeLessThan(at(f, 'shoulderR').z - 0.3);
  });

  it('swims lying forward, and keeps its hips where they are as it leans', () => {
    const swim = poseFor({ ...still, swimming: true });
    expect(swim.lean).toBeLessThan(-1);
    const f = new PlayerFigure(0xffffff);
    f.pose(poseFor(still));
    const hips = at(f, 'hips');
    f.pose(swim);
    expect(at(f, 'hips').distanceTo(hips)).toBeLessThan(0.01);
  });

  it('gives each name its own colour, the same every time', () => {
    expect(playerColor('eric').equals(playerColor('eric'))).toBe(true);
    expect(playerColor('eric').equals(playerColor('alex'))).toBe(false);
  });
});

describe('FigureMotion', () => {
  it('strides as far as it goes, and says what it is doing', () => {
    const m = new FigureMotion(0);
    let s = m.step({ x: 0, y: 0, z: 0 }, 0, 0, 0, null);
    // 1.4 m/s for a second, a frame every 1/60 s.
    for (let i = 1; i <= 60; i++) s = m.step({ x: (1.4 * 16 * i) / 60, y: 0, z: 0 }, (1000 * i) / 60, 0, 0, null);
    expect(s.speed).toBeCloseTo(1.4, 1);
    expect(s.stride).toBeCloseTo((1.4 * 2 * Math.PI) / 1.6, 1);
    s = m.step({ x: 22.4, y: 0, z: 0 }, 1100, PlayerAct.drawing | PlayerAct.airborne, 0.2, null);
    expect([s.airborne, s.draw, s.pitch]).toEqual([true, 0, 0.2]);
    s = m.step({ x: 22.4, y: 0, z: 0 }, 1550, PlayerAct.drawing, 0.2, null);
    expect(s.draw).toBeCloseTo(0.5, 2);
    expect(m.step({ x: 22.4, y: 0, z: 0 }, 1600, 0, 0, null).draw).toBeNull();
  });
});

describe('the animations in play', () => {
  it("are the server's library once it's sent: poses and grips follow it", async () => {
    const { setAnimations, animations } = await import('./playerFigure.js');
    const { defaultAnimations, Item } = await import('@super-vox/shared');
    const { heldGrip } = await import('./entities.js');
    try {
      const lib = defaultAnimations();
      lib.clips.jump.joints.legL = [{ at: 0, turn: [1.2, 0, 0] }];
      lib.grips.bow = { ...lib.grips.bow, hand: 'right', scale: 0.8 };
      setAnimations(lib);
      expect(animations()).toBe(lib);
      expect(poseFor({ ...still, airborne: true }).joints.legL![0]).toBeCloseTo(1.2, 5);
      expect(heldGrip(Item.Bow)).toMatchObject({ hand: 'right', scale: 0.8 });
    } finally {
      setAnimations((await import('@super-vox/shared')).defaultAnimations());
    }
    expect(poseFor({ ...still, airborne: true }).joints.legL![0]).toBeCloseTo(0.55, 5);
  });
});
