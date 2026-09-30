import * as THREE from 'three';
import { walkStep, type Mover, type WalkState } from './walking.js';

/** Keys currently held, by KeyboardEvent.code. */
export type HeldKeys = ReadonlySet<string>;

const MAX_PITCH = (89 * Math.PI) / 180;

/**
 * Movement direction for the held keys (not normalized to speed): W/S
 * forward/back and A/D strafe along the ground in the direction the camera
 * faces (yaw only), Space/E up, Q/C down. Returns a unit vector or zero.
 */
export function moveDirection(yaw: number, keys: HeldKeys): THREE.Vector3 {
  const f = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
  const r = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
  const u = (keys.has('Space') || keys.has('KeyE') ? 1 : 0) - (keys.has('KeyQ') || keys.has('KeyC') ? 1 : 0);
  // Yaw 0 faces -Z (three.js convention); right is +X.
  const v = new THREE.Vector3(
    -Math.sin(yaw) * f + Math.cos(yaw) * r,
    u,
    -Math.cos(yaw) * f - Math.sin(yaw) * r,
  );
  return v.lengthSq() > 0 ? v.normalize() : v;
}

/** Applies a mouse drag (pixels) to yaw/pitch; pitch is clamped short of straight up/down. */
export function applyLook(yaw: number, pitch: number, dx: number, dy: number, sensitivity: number): { yaw: number; pitch: number } {
  return {
    yaw: yaw - dx * sensitivity,
    pitch: Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitch - dy * sensitivity)),
  };
}

/**
 * First-person camera that walks (gravity, Space to jump) or flies. Click the view to capture the mouse (pointer lock);
 * while captured, moving the mouse looks around and button presses are
 * reported through `onClick`. Esc releases it. Uncaptured, dragging with the
 * left or right button still looks around. WASD moves, Space/E up, Q/C down,
 * Shift for 5x speed, mouse wheel changes the base speed (with Command held
 * it goes to `onModifiedWheel` instead). Flying: Space/E up, Q/C down.
 * Collision comes from `collide`; walking needs it.
 */
export class FlyControls {
  yaw = 0;
  pitch = 0;
  /** Base speed in metres per second (the wheel changes it, 1..500). */
  speed = 2;
  sensitivity = 0.0035;
  /** Lowest camera height allowed (metres). */
  minY = -Infinity;
  /**
   * Collision: given a desired move (metres) from the camera's position,
   * returns the move actually allowed and which axes were blocked.
   * Null = fly through everything (no-clip).
   */
  collide: Mover | null = null;
  /** Walking (gravity, jumping) instead of flying. Needs `collide`. */
  walking = false;
  /** Whether the world below the camera has loaded (gravity waits for it). */
  groundLoaded: () => boolean = () => true;
  private walk: WalkState = { vy: 0, grounded: false };
  private readonly keys = new Set<string>();
  private dragging = false;
  /** Mouse travel (pixels) since the button went down, to tell clicks from drags. */
  private dragTravel = 0;
  /**
   * Called for a mouse button press while the mouse is captured (0 = left,
   * 1 = middle, 2 = right), with the modifier keys held at that moment.
   */
  onClick: ((button: number, mods: { meta: boolean; alt: boolean }) => void) | null = null;
  /** Receives wheel movement (deltaY) while Command is held, instead of changing speed. */
  onModifiedWheel: ((deltaY: number) => void) | null = null;
  /** Called when the mouse is captured or released, with an error message if capture failed. */
  onPointerLockChange: ((locked: boolean, error?: string) => void) | null = null;
  private readonly listeners: [EventTarget, string, EventListener][] = [];

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly element: HTMLElement,
  ) {
    const on = <K extends keyof WindowEventMap>(target: EventTarget, type: K | string, fn: (e: never) => void) => {
      target.addEventListener(type, fn as EventListener);
      this.listeners.push([target, type, fn as EventListener]);
    };
    on(element, 'mousedown', (e: MouseEvent) => {
      if (this.pointerLocked) {
        // Captured: buttons are actions, not look-drags.
        this.onClick?.(e.button, { meta: e.metaKey, alt: e.altKey });
        return;
      }
      if (e.button === 0 || e.button === 2) {
        this.dragging = true;
        this.dragTravel = 0;
      }
    });
    on(window, 'mouseup', () => {
      // Uncaptured: a click (not a drag) captures the mouse.
      if (this.dragging && this.dragTravel < 5) this.requestPointerLock();
      this.dragging = false;
    });
    on(document, 'mousemove', (e: MouseEvent) => {
      if (!this.pointerLocked && !this.dragging) return;
      if (this.dragging) this.dragTravel += Math.abs(e.movementX) + Math.abs(e.movementY);
      ({ yaw: this.yaw, pitch: this.pitch } = applyLook(this.yaw, this.pitch, e.movementX, e.movementY, this.sensitivity));
    });
    on(document, 'pointerlockchange', () => {
      this.dragging = false;
      this.onPointerLockChange?.(this.pointerLocked);
    });
    on(document, 'pointerlockerror', () => this.onPointerLockChange?.(false, 'the browser refused to capture the mouse; wait a moment and click again'));
    on(element, 'contextmenu', (e: Event) => e.preventDefault());
    on(element, 'wheel', (e: WheelEvent) => {
      e.preventDefault();
      if (e.metaKey && this.onModifiedWheel) {
        // Normalize to pixels: some devices report lines or pages.
        const scale = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
        this.onModifiedWheel(e.deltaY * scale);
        return;
      }
      this.speed = Math.max(1, Math.min(500, this.speed * (e.deltaY > 0 ? 1 / 1.15 : 1.15)));
    });
    on(window, 'keydown', (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey) return;
      this.keys.add(e.code);
      if (e.code === 'Space') e.preventDefault();
    });
    on(window, 'keyup', (e: KeyboardEvent) => this.keys.delete(e.code));
    // Releasing keys while the window is unfocused would leave them "held".
    on(window, 'blur', () => this.keys.clear());
  }

  /** Whether the mouse is captured (pointer lock) by this view. */
  get pointerLocked(): boolean {
    return document.pointerLockElement === this.element;
  }

  /** Captures the mouse so moving it looks around; Esc releases it. */
  requestPointerLock(): void {
    try {
      // Chrome returns a promise that rejects if re-locking too soon after Esc.
      const r = this.element.requestPointerLock() as unknown;
      if (r instanceof Promise) r.catch(() => this.onPointerLockChange?.(false, 'the browser refused to capture the mouse; wait a moment and click again'));
    } catch {
      this.onPointerLockChange?.(false, 'this browser cannot capture the mouse; drag to look instead');
    }
  }

  /** Points the camera at a world position (metres). */
  lookAt(target: THREE.Vector3): void {
    const d = target.clone().sub(this.camera.position);
    this.yaw = Math.atan2(-d.x, -d.z);
    this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, Math.atan2(d.y, Math.hypot(d.x, d.z))));
    this.apply();
  }

  /** Moves and orients the camera; `dt` in seconds. */
  update(dt: number): void {
    const step = Math.min(dt, 0.1) * this.speed * (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 5 : 1);
    if (this.walking && this.collide) {
      // Walk along the ground in the facing direction; Space jumps.
      const dir = moveDirection(this.yaw, this.keys);
      dir.y = 0;
      if (dir.lengthSq() > 0) dir.normalize();
      const speed = step / Math.max(Math.min(dt, 0.1), 1e-6);
      const r = walkStep(
        this.walk,
        { dx: dir.x, dz: dir.z, speed, jump: this.keys.has('Space') },
        Math.min(dt, 0.1),
        this.collide,
        this.groundLoaded(),
      );
      this.walk = r.state;
      this.camera.position.add(new THREE.Vector3(...r.delta));
    } else {
      this.walk = { vy: 0, grounded: false };
      const delta = moveDirection(this.yaw, this.keys).multiplyScalar(step);
      this.camera.position.add(this.collide ? new THREE.Vector3(...this.collide([delta.x, delta.y, delta.z]).delta) : delta);
    }
    if (this.camera.position.y < this.minY) this.camera.position.y = this.minY;
    this.apply();
  }

  dispose(): void {
    for (const [target, type, fn] of this.listeners) target.removeEventListener(type, fn);
    this.listeners.length = 0;
  }

  private apply(): void {
    this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
  }
}
