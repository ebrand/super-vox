/**
 * Player chat, by radio: a player with a radio (Item.Radio, anywhere in their inventory) talks to,
 * and hears, everyone in the world with one; to one of them (/msg); and hears who came and went.
 * Without one, they're heard only by those within NEAR_METRES (speaking aloud), as anyone is, radio
 * or not. The server keeps the last HISTORY_LINES said by radio in each world, for those joining
 * with one.
 */
export interface ChatLine {
  /** When (ms since 1970). */
  at: number;
  /**
   * say: said to the world; private: to one player (`to`: who, as the sender sees it); join,
   * leave: someone came or went; info: the server to you (what went wrong, help).
   */
  kind: 'say' | 'private' | 'join' | 'leave' | 'info';
  /** Said by radio (else aloud: heard by those near). */
  radio?: boolean;
  /** Who said it (or came, or went). */
  from?: string;
  to?: string;
  text: string;
}

/** The longest a message may be (characters), how many are kept for joiners, and how many a player may send in RATE_MS. */
export const CHAT_MAX = 200;
export const HISTORY_LINES = 20;
export const RATE_COUNT = 5;
export const RATE_MS = 5000;
/** How far a voice carries (m), without a radio. */
export const NEAR_METRES = 30;

/** What was typed, as it's sent: control characters gone, spaces single, trimmed, no longer than CHAT_MAX. '' if nothing's left. */
export function cleanChat(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX);
}

/**
 * What a line typed means: said to the world; a private message (/msg, /m, /w, /tell: to the
 * player whose name the rest starts with, the longest of `names` that it does, any case: names
 * may have spaces); help (/help, /?); or not understood (why).
 */
export type ChatCommand = { kind: 'say'; text: string } | { kind: 'private'; to: string; text: string } | { kind: 'help' } | { kind: 'bad'; why: string };

export function readChat(text: string, names: readonly string[]): ChatCommand {
  if (!text.startsWith('/')) return { kind: 'say', text };
  const [word = '', ...rest] = text.slice(1).split(' ');
  const cmd = word.toLowerCase(), after = rest.join(' ');
  if (cmd === 'help' || cmd === '?') return { kind: 'help' };
  if (['msg', 'm', 'w', 'tell', 'whisper'].includes(cmd)) {
    const lower = after.toLowerCase();
    const to = [...names].sort((a, b) => b.length - a.length).find((n) => lower === n.toLowerCase() || lower.startsWith(`${n.toLowerCase()} `));
    if (!to) return { kind: 'bad', why: after ? `no one called "${after.split(' ')[0]}" is playing (names: as over their heads)` : 'who to? /msg <name> <message>' };
    const said = after.slice(to.length).trim();
    if (!said) return { kind: 'bad', why: `what to say to ${to}? /msg ${to} <message>` };
    return { kind: 'private', to, text: said };
  }
  return { kind: 'bad', why: `no such command "/${word}": /help says what there is` };
}

export const CHAT_HELP = `T or Enter to talk: with a radio in your inventory, everyone in this world with one hears you (and you them); without, only those within ${NEAR_METRES} m. /msg <name> <message>: to one player (by radio, both of you). Esc to stop typing. (A radio: 2 iron ingots, 2 copper coins and 2 planks, at a crafting table.)`;
