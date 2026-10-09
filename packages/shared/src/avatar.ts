/**
 * How a player looks: a colour for each part of their figure (skin: head, neck and hands; shirt:
 * body and arms; trousers: hips and legs; shoes: feet), "#rrggbb" each. Chosen on their account
 * page; until then (or if it's reset) one from their name (see defaultAvatar).
 */
export const AVATAR_PARTS = ['skin', 'shirt', 'trousers', 'shoes'] as const;
export type AvatarPart = (typeof AVATAR_PARTS)[number];
export type Avatar = Record<AvatarPart, string>;

const HEX = /^#[0-9a-f]{6}$/;

/** An avatar from what was sent, or null if it isn't one (every part, a lower-case #rrggbb). */
export function parseAvatar(raw: unknown): Avatar | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>, out: Partial<Avatar> = {};
  for (const p of AVATAR_PARTS) {
    const v = typeof r[p] === 'string' ? (r[p] as string).toLowerCase() : '';
    if (!HEX.test(v)) return null;
    out[p] = v;
  }
  return out as Avatar;
}

/** As sent with each player (see EntitySnapshot.look): the parts' colours in order, without the #s, comma-separated. */
export function avatarText(a: Avatar): string {
  return AVATAR_PARTS.map((p) => a[p].slice(1)).join(',');
}
export function avatarFromText(s: string): Avatar | null {
  const parts = s.split(',');
  if (parts.length !== AVATAR_PARTS.length) return null;
  return parseAvatar(Object.fromEntries(AVATAR_PARTS.map((p, i) => [p, `#${parts[i]}`])));
}

/** "#rrggbb" for an HSL colour (hue 0..1, saturation and lightness 0..1). */
function hsl(h: number, s: number, l: number): string {
  const f = (n: number) => {
    const k = (n + h * 12) % 12, a = s * Math.min(l, 1 - l);
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** The hue (0..1) a name has (the same everywhere it's seen). */
export function nameHue(name: string): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  return ((h >>> 0) % 360) / 360;
}

/** How someone looks who hasn't chosen: a shirt of their name's colour (as everyone was), plain the rest. */
export function defaultAvatar(name: string): Avatar {
  return { skin: '#d9b99b', shirt: hsl(nameHue(name), 0.32, 0.6), trousers: '#4a5568', shoes: '#2d2a26' };
}

/**
 * A name players go by (shown over their heads, in lists): 2 to 24 letters, digits, spaces and
 * _ . ' -, starting with a letter or digit, spaces not doubled; trimmed. Null if it won't do.
 */
export function cleanDisplayName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().replace(/\s+/g, ' ');
  if (s.length < 2 || s.length > 24) return null;
  return /^[\p{L}\p{N}][\p{L}\p{N} _.'-]*$/u.test(s) ? s : null;
}
