import {
  CLIP_IDS,
  defaultAnimations,
  parseAnimationLibrary,
  poseClip,
  type AnimClip,
  type AnimKey,
  type AnimationLibrary,
  type AnimSettings,
  type BodyKey,
  type ClipId,
  type FigureJoint,
  type FigurePose,
  type Grip,
  type GripKind,
} from '@super-vox/shared';

/**
 * Turns (radians, about x, y, z: applied y, then x, then z, as the figure's joints are) for the
 * same way round as `turn`, but as near `near` as can be: the other way of writing it (x past
 * straight up: π - x, y and z half way round) and whole turns of each, whichever's nearest. (A
 * handle dragged past 90° would otherwise flip y and z round, and keys would blend through it.)
 */
export function nearestTurn(turn: readonly number[], near: readonly number[]): [number, number, number] {
  const TAU = 2 * Math.PI;
  const closest = (v: number, to: number) => v + Math.round((to - v) / TAU) * TAU;
  const options = [
    [turn[0]!, turn[1]!, turn[2]!],
    [Math.PI - turn[0]!, turn[1]! + Math.PI, turn[2]! + Math.PI],
  ].map((o) => o.map((v, k) => closest(v, near[k]!)) as [number, number, number]);
  const dist = (o: number[]) => o.reduce((d, v, k) => d + (v - near[k]!) ** 2, 0);
  return dist(options[0]!) <= dist(options[1]!) ? options[0]! : options[1]!;
}

/** Keys this close (of a clip's way through) are the same key. */
const SAME = 0.004;

const copy = <T>(v: T): T => structuredClone(v);

/**
 * The animation designer's draft (see animator.ts): the library being edited, the clip and joint
 * picked, and where in the clip (t, 0..1) the playhead is. Changing a joint (or the body) at the
 * playhead changes its key there, or makes one (from where it is now, between the keys about it).
 * Nothing's kept till it's saved (see dirty, saved).
 */
export class AnimEditor {
  draft: AnimationLibrary;
  private saved: AnimationLibrary;
  clip: ClipId = 'walk';
  joint: FigureJoint | null = 'legL';
  t = 0;

  constructor(lib: AnimationLibrary = defaultAnimations()) {
    this.draft = copy(lib);
    this.saved = copy(lib);
  }

  get dirty(): boolean {
    return JSON.stringify(this.draft) !== JSON.stringify(this.saved);
  }

  /** Takes `lib` as both draft and saved (opened, or just saved). */
  load(lib: AnimationLibrary): void {
    this.draft = copy(lib);
    this.saved = copy(lib);
  }

  /** Back to what was saved. */
  revert(): void {
    this.draft = copy(this.saved);
  }

  /** The library as saved last (to send, or compare). */
  get savedLibrary(): AnimationLibrary {
    return this.saved;
  }

  /** The clip being edited back to how it is by default. */
  resetClip(id: ClipId = this.clip): void {
    this.draft.clips[id] = copy(defaultAnimations().clips[id]);
  }

  get current(): AnimClip {
    return this.draft.clips[this.clip];
  }

  /** The pose being edited: the clip alone at the playhead (an action clip over the standing pose). */
  pose(pitch = 0): FigurePose {
    const p = poseClip(this.draft, this.clip, this.t, pitch);
    if (this.clip !== 'dig' && this.clip !== 'bow') return p;
    const base = poseClip(this.draft, 'idle', 0, pitch);
    return { ...base, joints: { ...base.joints, ...p.joints } };
  }

  /** The joint's turn at the playhead (its keys, between), and how much it aims; null if the clip doesn't move it. */
  turnAt(joint: FigureJoint): { turn: [number, number, number]; aim: number } | null {
    const keys = this.current.joints[joint];
    if (!keys?.length) return null;
    const turn = poseClip(this.draft, this.clip, this.t, 0).joints[joint]!;
    const withAim = poseClip(this.draft, this.clip, this.t, 1).joints[joint]!;
    return { turn: [...turn], aim: withAim[0] - turn[0] };
  }

  /** Where the joint's keys are (0..1). */
  keysOf(joint: FigureJoint): number[] {
    return (this.current.joints[joint] ?? []).map((k) => k.at);
  }

  /** Every key in the clip (any joint, the body), where they are. */
  allKeys(): number[] {
    const at = new Set<number>();
    for (const keys of Object.values(this.current.joints)) for (const k of keys ?? []) at.add(k.at);
    for (const k of this.current.body ?? []) at.add(k.at);
    return [...at].sort((a, b) => a - b);
  }

  /** The joint's key at the playhead, if there's one. */
  keyHere(joint: FigureJoint): AnimKey | undefined {
    return this.current.joints[joint]?.find((k) => Math.abs(k.at - this.t) < SAME);
  }

  /**
   * Turns the joint at the playhead: its key there, or a new one (the clip not moving it yet: its
   * first key). A still pose has one key: that's it, wherever the playhead is.
   */
  setTurn(joint: FigureJoint, turn: [number, number, number], aim?: number): void {
    const c = this.current, keys = (c.joints[joint] ??= []);
    const at = c.driver === 'still' ? 0 : this.t;
    const k = keys.find((x) => Math.abs(x.at - at) < SAME) ?? (c.driver === 'still' ? keys[0] : undefined);
    const now = this.turnAt(joint);
    const a = aim ?? (k?.aim ?? now?.aim ?? 0);
    if (k) {
      k.turn = [...turn];
      if (a) k.aim = a;
      else delete k.aim;
    } else {
      keys.push({ at, turn: [...turn], ...(a ? { aim: a } : {}) });
      keys.sort((x, y) => x.at - y.at);
    }
  }

  /** Takes away the joint's key at the playhead (the last: the clip no longer moves it). */
  deleteKey(joint: FigureJoint): boolean {
    const keys = this.current.joints[joint];
    if (!keys) return false;
    const i = keys.findIndex((k) => Math.abs(k.at - this.t) < SAME);
    if (i < 0) return false;
    keys.splice(i, 1);
    if (!keys.length) delete this.current.joints[joint];
    return true;
  }

  /** Moves the joint's key at `from` to `to` (0..1; not onto another of its keys). */
  moveKey(joint: FigureJoint, from: number, to: number): boolean {
    const keys = this.current.joints[joint];
    const k = keys?.find((x) => Math.abs(x.at - from) < SAME);
    to = Math.max(0, Math.min(1, to));
    if (!keys || !k || keys.some((x) => x !== k && Math.abs(x.at - to) < SAME)) return false;
    k.at = to;
    keys.sort((x, y) => x.at - y.at);
    return true;
  }

  /** The body's lean and lift at the playhead. */
  bodyAt(): { lean: number; lift: number } {
    const p = poseClip(this.draft, this.clip, this.t);
    return { lean: p.lean, lift: p.lift };
  }

  /** Leans and lifts the body at the playhead (its key there, or a new one). */
  setBody(lean: number, lift: number): void {
    const c = this.current, keys: BodyKey[] = (c.body ??= []);
    const at = c.driver === 'still' ? 0 : this.t;
    const k = keys.find((x) => Math.abs(x.at - at) < SAME) ?? (c.driver === 'still' ? keys[0] : undefined);
    if (k) Object.assign(k, { lean, lift });
    else {
      keys.push({ at, lean, lift });
      keys.sort((a, b) => a.at - b.at);
    }
  }

  setSetting<K extends keyof AnimSettings>(key: K, value: number): void {
    this.draft.settings[key] = value;
  }

  setGrip(kind: GripKind, grip: Grip): void {
    this.draft.grips[kind] = copy(grip);
  }

  setClip(props: Partial<Pick<AnimClip, 'length' | 'smooth' | 'look'>>): void {
    Object.assign(this.current, copy(props));
  }

  /** Why the draft won't save (see parseAnimationLibrary), or '' if it will. */
  problem(): string {
    const r = parseAnimationLibrary(this.draft);
    return typeof r === 'string' ? r : '';
  }

  /** A library from an exported file: taken as the draft (to look over and save), or why it won't do. */
  importDraft(raw: unknown): string {
    const r = parseAnimationLibrary(raw);
    if (typeof r === 'string') return r;
    this.draft = r;
    return '';
  }
}

export { CLIP_IDS };
