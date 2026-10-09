import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { PlayerAct, SPRINT, WALK_SPEED, defaultAnimations, defaultAvatar, poseClip } from '@super-vox/shared';
import { FIGURE_HEIGHT, JOINTS, MAN, PlayerFigure, WOMAN_SCALE, figureModel, playerColor, poseFor, type FigureState } from './playerFigure.js';
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

  it('walks and runs: the legs half a stride apart, each arm against its leg; running leans forward', () => {
    for (const speed of [WALK_SPEED, WALK_SPEED * SPRINT]) {
      for (let k = 0; k < 8; k++) {
        const stride = (k / 8) * 2 * Math.PI;
        const now = poseFor({ ...still, speed, stride }), half = poseFor({ ...still, speed, stride: stride + Math.PI });
        // The right leg half a stride behind the left.
        expect(half.joints.legR![0]).toBeCloseTo(now.joints.legL![0], 1);
        // Each arm back as its leg goes forward (the leg's slant to the ground, against it).
        expect(Math.sign(now.joints.shoulderL![0]) * Math.sign(now.joints.legL![0] - now.lean * -1)).toBeLessThanOrEqual(1);
      }
    }
    expect(poseFor({ ...still, speed: WALK_SPEED }).lean).toBeCloseTo(0, 5);
    expect(poseFor({ ...still, speed: WALK_SPEED * SPRINT }).lean).toBeLessThan(-0.15);
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

  it('wears its look: each part its colour (head and hands skin, shirt, trousers, shoes), red when hurt', () => {
    const look = { skin: '#c68e6a', shirt: '#2255aa', trousers: '#333333', shoes: '#111111', figure: 'man' as const };
    const f = new PlayerFigure(look);
    const colorOf = (joint: string) => ((f.joints.get(joint as never)!.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial).color;
    for (const [joint, part] of [['head', 'skin'], ['wristR', 'skin'], ['chest', 'shirt'], ['elbowL', 'shirt'], ['hips', 'trousers'], ['kneeR', 'trousers'], ['ankleL', 'shoes']] as const)
      expect(colorOf(joint).getHexString(), joint).toBe(look[part].slice(1));
    f.tint(0.5);
    expect(colorOf('chest').equals(new THREE.Color(look.shirt).multiplyScalar(0.5))).toBe(true);
    f.tint(1, true);
    expect(colorOf('head').getHexString()).toBe('ff3030');
    f.setLook({ ...look, shirt: '#ff0000' });
    f.tint(1);
    expect(colorOf('spine').getHexString()).toBe('ff0000');
    // (A colour alone: a shirt that colour, the rest anyone's.)
    expect(((new PlayerFigure(0x00ff00).joints.get('chest')!.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial).color.getHexString()).toBe('00ff00');
  });
});

describe('FigureMotion', () => {
  it('strides as far as it goes, and says what it is doing', async () => {
    const m = new FigureMotion(0);
    let s = m.step({ x: 0, y: 0, z: 0 }, 0, 0, 0, null);
    // 1.4 m/s for a second, a frame every 1/60 s.
    for (let i = 1; i <= 60; i++) s = m.step({ x: (1.4 * 16 * i) / 60, y: 0, z: 0 }, (1000 * i) / 60, 0, 0, null);
    expect(s.speed).toBeCloseTo(1.4, 1);
    expect(s.stride).toBeCloseTo((1.4 * 2 * Math.PI) / (await import('./playerFigure.js')).strides().walk, 1);
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

describe('strides locked to the feet', () => {
  it("move the body as far as a planted foot carries it: the foot on the ground doesn't slide", async () => {
    const { defaultAnimations: defaults } = await import('@super-vox/shared');
    const { lockedStride, measureStrides } = await import('./playerFigure.js');
    const lib = defaults();
    expect(lib.settings.walkStride).toBe(0); // locked, by default
    for (const [clip, speed] of [['walk', WALK_SPEED], ['run', WALK_SPEED * SPRINT]] as const) {
      const stride = lockedStride(lib, clip)!;
      expect(stride).toBeGreaterThan(0.5);
      // Through the world at `speed`, the stride turning as far as it goes: where the left foot is
      // (world z: the body's way forward plus the foot's own), frame by frame.
      const f = new PlayerFigure(0xffffff), foot = f.joints.get('ankleL')!, box = new THREE.Box3();
      const dt = 1 / 240, T = stride / speed;
      const at: { y: number; z: number }[] = [];
      for (let t = 0; t < T; t += dt) {
        f.pose(poseFor({ ...still, speed, stride: (2 * Math.PI * t) / T }));
        f.root.position.z = -speed * t;
        f.root.updateMatrixWorld(true);
        box.setFromObject(foot);
        at.push({ y: box.min.y, z: (box.min.z + box.max.z) / 2 });
      }
      // While it's down (on the ground: as low as the sole goes, give or take), it stays put: most
      // of the time it hardly moves (the middle of its speeds under a tenth of the body's).
      const speeds: number[] = [];
      for (let i = 1; i < at.length; i++) if (at[i]!.y < 0.005 && at[i - 1]!.y < 0.005) speeds.push(Math.abs(at[i]!.z - at[i - 1]!.z) / dt);
      expect(speeds.length, clip).toBeGreaterThan(at.length * 0.15);
      speeds.sort((a, b) => a - b);
      expect(speeds[Math.floor(speeds.length / 2)]!, clip).toBeLessThan(speed * 0.1);
    }
    // A stride set: that, not locked.
    lib.settings.walkStride = 2;
    expect(measureStrides(lib).walk).toBe(2);
  });
});

describe('walking and running forwards', () => {
  it("lifts the foot that's swinging forward, and plants the one going back", () => {
    const f = new PlayerFigure(0xffffff);
    const footY = (j: string) => {
      f.root.updateMatrixWorld(true);
      return new THREE.Box3().setFromObject(f.joints.get(j as never)!).min.y;
    };
    for (const speed of [WALK_SPEED, WALK_SPEED * SPRINT])
      for (let k = 0; k < 16; k++) {
        const stride = (k / 16) * 2 * Math.PI;
        const a = poseFor({ ...still, speed, stride }), b = poseFor({ ...still, speed, stride: stride + 0.1 });
        // Halfway through the left leg's swing forward (its slant rising fastest): its foot is up, the right one down.
        const rising = b.joints.legL![0] - a.joints.legL![0];
        if (rising < 0.15) continue;
        f.pose(a);
        expect(footY('ankleL'), `${speed} m/s, stride ${k}/16`).toBeGreaterThan(footY('ankleR') + 0.03);
      }
  });
});

describe('walking and running gently', () => {
  it("bob a little (a walk's 4 or 5 cm, a run's 6) and never put a foot in the ground", () => {
    const lib = defaultAnimations(), f = new PlayerFigure(0xffffff), box = new THREE.Box3();
    for (const [clip, most] of [['walk', 0.05], ['run', 0.07]] as const) {
      const hips: number[] = [];
      for (let i = 0; i < 256; i++) {
        f.pose(poseClip(lib, clip, i / 256));
        hips.push(at(f, 'legL').y);
        // (Exact on the keys; between them, blended, a few millimeters in as a running foot lands.)
        for (const foot of ['ankleL', 'ankleR'] as const) expect(box.setFromObject(f.joints.get(foot)!).min.y, `${clip} ${foot} ${i}/256`).toBeGreaterThan(-0.01);
      }
      const bob = Math.max(...hips) - Math.min(...hips);
      expect(bob, clip).toBeLessThan(most);
      expect(bob, clip).toBeGreaterThan(0.03); // (still some: people do)
    }
  });
});

describe('walking and running speeds', () => {
  it("are a figure's: walking a walk (pure, a natural pace), sprinting a run", async () => {
    const { strides } = await import('./playerFigure.js');
    const s = defaultAnimations().settings, st = strides();
    expect(WALK_SPEED).toBeLessThanOrEqual(s.runFrom);
    expect(WALK_SPEED * SPRINT).toBeGreaterThanOrEqual(s.runTo);
    expect(WALK_SPEED * SPRINT).toBeCloseTo(4.3, 5); // (the old walking pace)
    // Steps a minute, feet locked: a walk's (people: 100 to 160) and a run's (people: 150 to 190).
    const walking = (2 * WALK_SPEED * 60) / st.walk, running = (2 * WALK_SPEED * SPRINT * 60) / st.run;
    expect(walking).toBeGreaterThan(100);
    expect(walking).toBeLessThan(160);
    expect(running).toBeGreaterThan(120);
    expect(running).toBeLessThan(190);
  });
});

describe('the woman', () => {
  const her = { ...defaultAvatar('x'), figure: 'woman' as const };
  const size = (f: PlayerFigure) => {
    f.pose(poseFor(still));
    f.root.updateMatrixWorld(true);
    return new THREE.Box3().setFromObject(f.root);
  };
  it("stands on the ground, a little smaller than the man: narrower in the shoulders, wider in the hips", () => {
    const man = new PlayerFigure(defaultAvatar('x')), woman = new PlayerFigure(her);
    const m = size(man), w = size(woman);
    expect(w.min.y).toBeCloseTo(0, 2);
    // (A little smaller all over, her head a little smaller again: a centimetre.)
    const ratio = (w.max.y - w.min.y) / (m.max.y - m.min.y);
    expect(ratio).toBeLessThan(WOMAN_SCALE);
    expect(ratio).toBeGreaterThan(WOMAN_SCALE - 0.01);
    expect(woman.height).toBeCloseTo(FIGURE_HEIGHT * WOMAN_SCALE, 5);
    const width = (f: PlayerFigure, joint: string) => new THREE.Box3().setFromObject(f.joints.get(joint as never)!.children[0]!).getSize(new THREE.Vector3()).x;
    expect(width(woman, 'hips') / width(man, 'hips')).toBeGreaterThan(1);
    expect(Math.abs(at(woman, 'shoulderL').x - at(woman, 'shoulderR').x)).toBeLessThan(Math.abs(at(man, 'shoulderL').x - at(man, 'shoulderR').x) * WOMAN_SCALE);
    expect(Math.abs(at(woman, 'legL').x - at(woman, 'legR').x)).toBeGreaterThan(Math.abs(at(man, 'legL').x - at(man, 'legR').x) * WOMAN_SCALE);
  });

  it('strides as her legs are long (her feet locked to the ground as his are)', async () => {
    const { lockedStride } = await import('./playerFigure.js');
    const lib = defaultAnimations();
    for (const clip of ['walk', 'run'] as const) {
      const his = lockedStride(lib, clip, new PlayerFigure(defaultAvatar('x')))!, hers = lockedStride(lib, clip, new PlayerFigure(her))!;
      expect(hers / his, clip).toBeCloseTo(WOMAN_SCALE, 1);
      expect(new PlayerFigure(her).strideScale).toBe(WOMAN_SCALE);
    }
  });

  it('a figure becomes the other as its look says, at once', () => {
    const f = new PlayerFigure(defaultAvatar('x'));
    const tall = size(f).max.y;
    f.setLook(her);
    expect(f.strideScale).toBe(WOMAN_SCALE);
    expect(size(f).max.y / tall).toBeGreaterThan(WOMAN_SCALE - 0.01);
    expect(size(f).max.y / tall).toBeLessThan(WOMAN_SCALE);
    f.setLook(defaultAvatar('x'));
    expect(size(f).max.y).toBeCloseTo(tall, 5);
  });
});
