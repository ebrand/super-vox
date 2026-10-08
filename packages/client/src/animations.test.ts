import { describe, expect, it } from 'vitest';
import { FIGURE_JOINTS, defaultAnimations, poseFigure, type FigurePose as Pose, type FigureState } from '@super-vox/shared';

// Today's poses, as the code made them before the library (kept here: the defaults must match them).
type Joint = (typeof FIGURE_JOINTS)[number];
/** How fast walking turns to running (m/s), and how long a dig's swing takes (s). */
const RUN_FROM = 4.6;
const DIG_S = 0.32;

/**
 * The pose for what a player's doing. Turning about x tips a part's lower end forward (a leg
 * forward, an arm raised in front); a knee or elbow bends back with negative x (knee) or forward
 * with positive x (elbow); about z, an arm out to the side (left: -, right: +).
 */
function legacyPose(s: FigureState): Pose {
  const j: Pose['joints'] = {};
  const set = (k: Joint, x: number, y = 0, z = 0) => (j[k] = [x, y, z]);
  let lean = 0, lift = 0;
  const breath = Math.sin(s.time * 1.6) * 0.02;
  // Arms hang a little out; a breath lifts the chest.
  set('shoulderL', 0, 0, -0.08 - breath);
  set('shoulderR', 0, 0, 0.08 + breath);
  set('chest', -breath);
  if (s.swimming) {
    // Swimming: lying forward, legs fluttering, arms sweeping round in a stroke.
    lean = -1.25;
    const f = Math.sin(s.time * 9) * 0.35, stroke = s.time * 2.6;
    set('legL', f);
    set('legR', -f);
    set('kneeL', -0.3 - Math.max(0, f));
    set('kneeR', -0.3 - Math.max(0, -f));
    set('shoulderL', 2.6 + Math.sin(stroke) * 0.6, 0, -0.6 - Math.cos(stroke) * 0.5);
    set('shoulderR', 2.6 + Math.sin(stroke) * 0.6, 0, 0.6 + Math.cos(stroke) * 0.5);
    set('elbowL', 0.4);
    set('elbowR', 0.4);
    set('head', 0.9 + s.pitch * 0.3);
  } else if (s.flying) {
    // Flying: legs together, a little back; arms a little out; leaning into it the faster it goes.
    lean = -Math.min(0.5, s.speed * 0.03);
    set('legL', -0.15);
    set('legR', -0.1);
    set('kneeL', -0.25);
    set('kneeR', -0.2);
    set('shoulderL', 0.1, 0, -0.35);
    set('shoulderR', 0.1, 0, 0.35);
    set('head', s.pitch * 0.6 - lean);
  } else if (s.airborne) {
    // Jumping or falling: knees up, arms out for balance.
    set('legL', 0.55);
    set('legR', 0.25);
    set('kneeL', -0.9);
    set('kneeR', -0.6);
    set('shoulderL', 0.3, 0, -0.55);
    set('shoulderR', 0.3, 0, 0.55);
    set('head', s.pitch * 0.6);
  } else {
    // Standing, walking, running: legs swing (knees bending on the way back), arms the other way.
    const go = Math.min(1, s.speed / 1.5), run = smooth(RUN_FROM, RUN_FROM + 1, s.speed);
    const swing = go * (0.45 + 0.35 * run), sinS = Math.sin(s.stride), cosS = Math.cos(s.stride);
    set('legL', swing * sinS);
    set('legR', -swing * sinS);
    // (Corrected since: each knee bends as its leg swings forward, enough to lift the foot; it bent going back, a walk backwards.)
    set('kneeL', -go * (0.7 + 0.35 * run) * Math.max(0, cosS) - go * 0.15);
    set('kneeR', -go * (0.7 + 0.35 * run) * Math.max(0, -cosS) - go * 0.15);
    set('ankleL', go * 0.2 * Math.max(0, cosS));
    set('ankleR', go * 0.2 * Math.max(0, -cosS));
    set('shoulderL', -swing * 0.8 * sinS, 0, -0.08 - breath);
    set('shoulderR', swing * 0.8 * sinS, 0, 0.08 + breath);
    set('elbowL', go * (0.25 + 0.9 * run));
    set('elbowR', go * (0.25 + 0.9 * run));
    lean = -0.22 * run;
    // A step's bob: lowest as the feet pass.
    // (Corrected since: a walk's lowest with the legs apart; a run's as they pass.)
    lift = -go * (0.02 * (1 - run) * Math.abs(sinS) + 0.05 * run * Math.abs(cosS));
    set('head', s.pitch * 0.6 - lean);
    set('chest', -breath + s.pitch * 0.15);
  }
  // Digging (over and over) or a swing: the right arm up over the shoulder and chopping down, the body turning into it.
  const chop = s.mining ? (s.time % DIG_S) / DIG_S : s.swing;
  if (chop !== null && s.draw === null) {
    const u = chop < 0.35 ? chop / 0.35 : 1 - (chop - 0.35) / 0.65;
    set('shoulderR', 0.4 + 2.3 * u, 0, 0.15);
    set('elbowR', 0.6 - 0.5 * u);
    set('spine', 0, -0.25 * u, 0);
  }
  // A bow: the left arm holding it out where it looks; the right drawing the string back to the chin.
  if (s.draw !== null) {
    // (The body turned a little, its left shoulder toward the shot; the bow arm and the head turned
    // back as much, so they point along it.)
    const twist = -0.35, d = s.draw, lerp = (a: number, b: number) => a + (b - a) * d;
    set('spine', 0, twist, 0);
    set('shoulderL', Math.PI / 2 + s.pitch, -twist, 0);
    set('elbowL', 0);
    // The drawing arm: from out in front at the string, round until the hand's at the cheek.
    set('shoulderR', lerp(Math.PI / 2 + s.pitch, 1.2), lerp(0.35, 0.6), lerp(0, -1.0));
    set('elbowR', lerp(0.3, 1.6));
    set('head', s.pitch * 0.8, -twist, 0);
  }
  return { joints: j, lean, lift };
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};


describe('the default animation library', () => {
  it('poses figures as the code did (but the swimming legs: four beats to a stroke; and the knees and bob of a stride, put right)', () => {
    const lib = defaultAnimations();
    const base: FigureState = { time: 0, stride: 0, speed: 0, airborne: false, swimming: false, flying: false, mining: false, swing: null, draw: null, pitch: 0 };
    const states: FigureState[] = [];
    for (const time of [0, 0.7, 1.9, 3.3])
      for (const pitch of [0, 0.4, -0.6]) {
        for (const speed of [0, 0.7, 1.4, 4.3, 5.1, 7]) for (const stride of [0, 0.9, 2.2, 3.5, 5.1]) states.push({ ...base, time, pitch, speed, stride });
        states.push({ ...base, time, pitch, swimming: true }, { ...base, time, pitch, flying: true, speed: 8 }, { ...base, time, pitch, airborne: true });
        for (const swing of [0, 0.2, 0.35, 0.6, 0.99]) states.push({ ...base, time, pitch, swing });
        states.push({ ...base, time, pitch, mining: true });
        for (const draw of [0, 0.4, 1]) states.push({ ...base, time, pitch, draw }, { ...base, time, pitch, draw, swing: 0.5 });
      }
    let worst = { d: 0, at: '' };
    for (const s of states) {
      const a = legacyPose(s), b = poseFigure(lib, s);
      for (const j of FIGURE_JOINTS) {
        if (s.swimming && /^(leg|knee)/.test(j)) continue;
        const ra = a.joints[j] ?? [0, 0, 0], rb = b.joints[j] ?? [0, 0, 0];
        for (let k = 0; k < 3; k++) {
          const d = Math.abs(ra[k]! - rb[k]!);
          if (d > worst.d) worst = { d, at: `${j}[${k}] ${JSON.stringify(s)}: ${ra[k]} vs ${rb[k]}` };
        }
      }
      expect(Math.abs(a.lean - b.lean), JSON.stringify(s)).toBeLessThan(0.01);
      expect(Math.abs(a.lift - b.lift), JSON.stringify(s)).toBeLessThan(0.006);
    }
    expect(worst.d, worst.at).toBeLessThan(0.035);
  });
});
