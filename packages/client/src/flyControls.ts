import * as THREE from 'three';

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
 * Free-flying camera: drag with the left or right mouse button to look,
 * WASD to move, Space/E up, Q/C down, Shift for 5x speed, mouse wheel to
 * change the base speed. No collision.
 */
export class FlyControls {
  yaw = 0;
  pitch = 0;
  /** Base speed in metres per second. */
  speed = 10;
  sensitivity = 0.0035;
  /** Lowest camera height allowed (metres). */
  minY = -Infinity;
  private readonly keys = new Set<string>();
  private dragging = false;
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
      if (e.button === 0 || e.button === 2) this.dragging = true;
    });
    on(window, 'mouseup', () => (this.dragging = false));
    on(window, 'mousemove', (e: MouseEvent) => {
      if (!this.dragging) return;
      ({ yaw: this.yaw, pitch: this.pitch } = applyLook(this.yaw, this.pitch, e.movementX, e.movementY, this.sensitivity));
    });
    on(element, 'contextmenu', (e: Event) => e.preventDefault());
    on(element, 'wheel', (e: WheelEvent) => {
      e.preventDefault();
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
    this.camera.position.addScaledVector(moveDirection(this.yaw, this.keys), step);
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
