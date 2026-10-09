import { describe, expect, it } from 'vitest';
import { CHAT_MAX, cleanChat, readChat } from './chat.js';

describe('chat', () => {
  it('cleans what was typed: no control or invisible characters, spaces single, not too long', () => {
    expect(cleanChat('  hello\\n\\tthere  ')).toBe('hello\\n\\tthere');
    expect(cleanChat('hi\nthere\t!')).toBe('hi there !');
    expect(cleanChat(`a${String.fromCharCode(0x200b)}b${String.fromCharCode(0x2028)}c${String.fromCharCode(0x202e)}d`)).toBe('a b c d');
    expect(cleanChat('x'.repeat(500)).length).toBe(CHAT_MAX);
    expect(cleanChat('   ')).toBe('');
    expect(cleanChat(42)).toBe('');
  });

  it('reads commands: /msg to a player (names with spaces: the longest that fits), /help, the rest said', () => {
    const names = ['Ann', 'Ann Smith', 'Bob'];
    expect(readChat('hello all', names)).toEqual({ kind: 'say', text: 'hello all' });
    expect(readChat('/msg ann smith are you there?', names)).toEqual({ kind: 'private', to: 'Ann Smith', text: 'are you there?' });
    expect(readChat('/w Ann hi', names)).toEqual({ kind: 'private', to: 'Ann', text: 'hi' });
    expect(readChat('/msg bob', names)).toMatchObject({ kind: 'bad', why: expect.stringMatching(/what to say/) });
    expect(readChat('/msg carl hi', names)).toMatchObject({ kind: 'bad', why: expect.stringMatching(/carl/) });
    expect(readChat('/help', names)).toEqual({ kind: 'help' });
    expect(readChat('/dance', names)).toMatchObject({ kind: 'bad', why: expect.stringMatching(/dance/) });
  });
});
