import { describe, expect, it } from 'vitest';
import { defaultAnimations } from '@super-vox/shared';
import { AnimEditor } from './animEditor.js';

describe('AnimEditor', () => {
  it('turns a joint at the playhead: its key there, or a new one (from where it was)', () => {
    const e = new AnimEditor();
    e.clip = 'dig';
    // Between the dig's keys (0, 0.35, 1): a new one at 0.6.
    e.t = 0.6;
    const was = e.turnAt('shoulderR')!.turn;
    expect(was[0]).toBeGreaterThan(0.4);
    expect(was[0]).toBeLessThan(2.7);
    e.setTurn('shoulderR', [1, 0.2, 0.3]);
    expect(e.keysOf('shoulderR')).toEqual([0, 0.35, 0.6, 1]);
    expect(e.turnAt('shoulderR')!.turn).toEqual([1, 0.2, 0.3]);
    // On a key: that key.
    e.t = 0.35;
    e.setTurn('shoulderR', [2, 0, 0]);
    expect(e.keysOf('shoulderR')).toEqual([0, 0.35, 0.6, 1]);
    expect(e.current.joints.shoulderR![1]!.turn).toEqual([2, 0, 0]);
    expect(e.dirty).toBe(true);
    e.revert();
    expect(e.dirty).toBe(false);
    expect(e.keysOf('shoulderR')).toEqual([0, 0.35, 1]);
  });

  it('keeps how much a key aims (the bow arm follows where they look) unless told', () => {
    const e = new AnimEditor();
    e.clip = 'bow';
    e.t = 0;
    expect(e.turnAt('shoulderL')!.aim).toBeCloseTo(1, 5);
    e.setTurn('shoulderL', [1.5, 0.3, 0]);
    expect(e.turnAt('shoulderL')!.aim).toBeCloseTo(1, 5);
    e.setTurn('shoulderL', [1.5, 0.3, 0], 0);
    expect(e.current.joints.shoulderL![0]!.aim).toBeUndefined();
  });

  it('a still pose has one key, whatever the playhead says; a joint it does not move gets one', () => {
    const e = new AnimEditor();
    e.clip = 'jump';
    e.t = 0.7;
    e.setTurn('legL', [1, 0, 0]);
    expect(e.current.joints.legL).toEqual([{ at: 0, turn: [1, 0, 0] }]);
    expect(e.turnAt('head')).toBeNull();
    e.setTurn('head', [0.2, 0, 0]);
    expect(e.keysOf('head')).toEqual([0]);
  });

  it('takes keys away (the last: the joint is no longer moved) and moves them (not onto another)', () => {
    const e = new AnimEditor();
    e.clip = 'dig';
    e.t = 0.35;
    expect(e.deleteKey('elbowR')).toBe(true);
    expect(e.keysOf('elbowR')).toEqual([0, 1]);
    expect(e.deleteKey('elbowR')).toBe(false); // none there now
    expect(e.moveKey('elbowR', 1, 0)).toBe(false); // onto another
    expect(e.moveKey('elbowR', 1, 0.8)).toBe(true);
    expect(e.keysOf('elbowR')).toEqual([0, 0.8]);
    e.t = 0;
    e.deleteKey('elbowR');
    e.t = 0.8;
    e.deleteKey('elbowR');
    expect(e.current.joints.elbowR).toBeUndefined();
    expect(e.allKeys()).toEqual([0, 0.35, 1]);
  });

  it('leans the body at the playhead, sets settings, grips and a clip, resets a clip, and says why a draft will not save', () => {
    const e = new AnimEditor();
    e.clip = 'fly';
    e.setBody(-0.3, 0.05);
    expect(e.bodyAt()).toEqual({ lean: -0.3, lift: 0.05 });
    e.setSetting('digSeconds', 0.5);
    e.setGrip('bow', { hand: 'right', at: [0, 0, 0], turn: [0, 0, 0], scale: 1 });
    e.clip = 'swim';
    e.setClip({ length: 3 });
    expect([e.draft.settings.digSeconds, e.draft.grips.bow.hand, e.draft.clips.swim.length]).toEqual([0.5, 'right', 3]);
    e.resetClip('swim');
    expect(e.draft.clips.swim).toEqual(defaultAnimations().clips.swim);
    expect(e.problem()).toBe('');
    e.setSetting('runTo', 1);
    expect(e.problem()).toMatch(/runFrom < runTo/);
    expect(e.importDraft({ clips: { nope: {} } })).toMatch(/nope/);
    expect(e.importDraft({ settings: { digSeconds: 0.25 } })).toBe('');
    expect(e.draft.settings.digSeconds).toBe(0.25);
  });

  it("scales how far a joint or the body moves through a clip, about the middle of it", () => {
    const e = new AnimEditor();
    const lifts = () => e.current.body!.map((k) => k.lift);
    const range = (v: number[]) => Math.max(...v) - Math.min(...v);
    const was = lifts(), mid = (Math.max(...was) + Math.min(...was)) / 2;
    expect(e.scaleKeys('lift', 0.5)).toBe(true);
    expect(range(lifts())).toBeCloseTo(range(was) / 2, 9);
    expect((Math.max(...lifts()) + Math.min(...lifts())) / 2).toBeCloseTo(mid, 9);
    expect(e.current.body!.map((k) => k.lean)).toEqual(defaultAnimations().clips.walk.body!.map((k) => k.lean)); // lean as it was
    // A joint: each turn, about its own middle (an arm's z, not moving, stays).
    const arm = () => e.current.joints.shoulderL!.map((k) => k.turn);
    const before = arm().map((t) => [...t]);
    e.scaleKeys('shoulderL', 1.5);
    expect(range(arm().map((t) => t[0]))).toBeCloseTo(range(before.map((t) => t[0]!)) * 1.5, 9);
    expect(arm().map((t) => t[2])).toEqual(before.map((t) => t[2]!));
    expect(e.dirty).toBe(true);
    // Nothing that moves: nothing to scale.
    expect(e.scaleKeys('head', 0.5)).toBe(false);
    e.clip = 'jump';
    expect(e.scaleKeys('legL', 0.5)).toBe(false);
    expect(e.scaleKeys('lift', -1)).toBe(false);
  });

  it('shows an action over the standing pose (a dig: the legs stand)', () => {
    const e = new AnimEditor();
    e.clip = 'dig';
    e.t = 0.35;
    const p = e.pose();
    expect(p.joints.shoulderR![0]).toBeCloseTo(2.7, 5);
    expect(p.joints.shoulderL![2]).toBeCloseTo(-0.08, 5); // idle's arm
  });
});

describe('nearestTurn', () => {
  it('writes a turn the way nearest to how it was (past 90° about x: no flip of y and z)', async () => {
    const THREE = await import('three');
    const { nearestTurn } = await import('./animEditor.js');
    // An elbow bent 120° (about x): the YXZ angles of it come back as x 60°, y and z 180°.
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler((120 * Math.PI) / 180, 0, 0, 'YXZ'));
    const e = new THREE.Euler().setFromQuaternion(q, 'YXZ');
    expect(Math.abs(e.y)).toBeCloseTo(Math.PI, 3);
    const t = nearestTurn([e.x, e.y, e.z], [1.9, 0, 0]);
    expect(t[0]).toBeCloseTo((120 * Math.PI) / 180, 5);
    expect(t[1]).toBeCloseTo(0, 5);
    expect(t[2]).toBeCloseTo(0, 5);
    // The same way round.
    const back = new THREE.Quaternion().setFromEuler(new THREE.Euler(t[0], t[1], t[2], 'YXZ'));
    expect(Math.abs(back.dot(q))).toBeCloseTo(1, 6);
    // Whole turns: -170° next to 175° is 190°.
    expect(nearestTurn([(-170 * Math.PI) / 180, 0, 0], [(175 * Math.PI) / 180, 0, 0])[0]).toBeCloseTo((190 * Math.PI) / 180, 5);
  });
});
