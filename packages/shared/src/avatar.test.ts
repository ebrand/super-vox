import { describe, expect, it } from 'vitest';
import { avatarFromText, avatarText, cleanDisplayName, defaultAvatar, parseAvatar } from './avatar.js';

describe('avatars', () => {
  it('are a colour for each part, sent as text and back', () => {
    const a = { skin: '#c68e6a', shirt: '#2255aa', trousers: '#333333', shoes: '#111111' };
    expect(parseAvatar({ ...a, shirt: '#2255AA', extra: 1 })).toEqual(a);
    expect(parseAvatar({ ...a, shoes: 'red' })).toBeNull();
    expect(parseAvatar({ skin: '#ffffff' })).toBeNull();
    expect(parseAvatar('x')).toBeNull();
    expect(avatarText(a)).toBe('c68e6a,2255aa,333333,111111');
    expect(avatarFromText(avatarText(a))).toEqual(a);
    expect(avatarFromText('nope')).toBeNull();
  });

  it("someone who hasn't chosen: a shirt of their name's colour (as everyone was), the same every time", () => {
    expect(defaultAvatar('eric')).toEqual(defaultAvatar('eric'));
    expect(defaultAvatar('eric').shirt).not.toBe(defaultAvatar('alex').shirt);
    expect(parseAvatar(defaultAvatar('eric'))).not.toBeNull();
  });

  it("names: 2 to 24 of letters, digits, spaces and _ . ' -, starting with a letter or digit, trimmed, spaces single", () => {
    expect(cleanDisplayName('  Annie   B ')).toBe('Annie B');
    expect(cleanDisplayName("O'Neil-Smith_2.0")).toBe("O'Neil-Smith_2.0");
    expect(cleanDisplayName('Zoë')).toBe('Zoë');
    for (const bad of ['A', 'x'.repeat(25), '-lead', 'semi;colon', '<b>', '', 7, null]) expect(cleanDisplayName(bad), String(bad)).toBeNull();
  });
});
