import { CHAT_MAX, defaultAvatar, type ChatLine } from '@super-vox/shared';

/**
 * The chat box (the game, bottom left): what's said, as it comes (said by radio; aloud, near you;
 * to you alone; who came and went; the server's notes), each new line showing a while and fading;
 * opened (T, Enter, or / for a command), every line kept lately, and a line to type in. Enter
 * sends what's typed (see the server's chat: by radio, or aloud); Esc stops typing.
 */
export class ChatBox {
  readonly root: HTMLDivElement;
  private readonly log: HTMLDivElement;
  private readonly input: HTMLInputElement;
  private readonly hint: HTMLDivElement;
  private open = false;
  /** Lines shown before they start to fade (ms), and how long fading takes. */
  static readonly SHOW_MS = 10_000;
  static readonly FADE_MS = 1_500;
  private static readonly KEEP = 100;

  constructor(
    private readonly send: (text: string) => void,
    /** Whether we've a radio with us (to say so as we type). */
    private readonly hasRadio: () => boolean,
    /** Typing stopped: `sent`, a line was sent (Enter: a key press, the mouse may be captured again). */
    private readonly closed: (sent: boolean) => void,
  ) {
    this.root = document.createElement('div');
    this.root.id = 'chat';
    this.log = document.createElement('div');
    this.log.className = 'chat-log';
    this.hint = document.createElement('div');
    this.hint.className = 'chat-hint';
    this.input = document.createElement('input');
    this.input.className = 'chat-input';
    this.input.maxLength = CHAT_MAX;
    this.input.autocomplete = 'off';
    this.input.spellcheck = false;
    this.root.append(this.log, this.hint, this.input);
    this.input.addEventListener('keydown', (e) => {
      if (e.code === 'Enter') {
        e.preventDefault();
        const text = this.input.value.trim();
        if (text) this.send(text);
        this.close(true);
      } else if (e.code === 'Escape') {
        e.preventDefault();
        this.close(false);
      }
      // (Typing: not the game's keys, nor the page's.)
      e.stopPropagation();
    });
    this.input.addEventListener('input', () => this.showHint());
    this.close(false);
    setInterval(() => this.fade(), 250);
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** Opens it to type (`start` already typed: "/" for a command). */
  openToType(start = ''): void {
    this.open = true;
    this.root.classList.add('open');
    this.input.hidden = false;
    this.input.value = start;
    this.showHint();
    this.fade();
    this.log.scrollTop = this.log.scrollHeight;
    // (At once: the key that opened it isn't typed into it, as the game doesn't let it be: see main.ts.)
    this.input.focus();
  }

  close(sent: boolean): void {
    const was = this.open;
    this.open = false;
    this.root.classList.remove('open');
    this.input.hidden = true;
    this.hint.hidden = true;
    this.input.blur();
    this.fade();
    if (was) this.closed(sent);
  }

  /** Lines heard (`history`: what was said before we came: shown, not as new). */
  add(lines: readonly ChatLine[], history = false): void {
    for (const l of lines) {
      const row = document.createElement('div');
      row.className = `chat-line ${l.kind}${l.kind === 'say' && !l.radio ? ' aloud' : ''}`;
      row.dataset.at = String(history ? 0 : performance.now());
      const name = (who: string) => {
        const b = document.createElement('b');
        b.textContent = who;
        b.style.color = defaultAvatar(who).shirt;
        return b;
      };
      if (l.kind === 'say') {
        row.append(name(l.from ?? '?'));
        if (!l.radio) row.append(span(' (nearby)', 'tag'));
        row.append(`: ${l.text}`);
      } else if (l.kind === 'private') {
        row.append(span('to ', 'tag'), name(l.to ?? '?'), span(' from ', 'tag'), name(l.from ?? '?'), `: ${l.text}`);
      } else row.append(l.text);
      row.title = new Date(l.at).toLocaleTimeString();
      this.log.append(row);
    }
    while (this.log.children.length > ChatBox.KEEP) this.log.firstElementChild!.remove();
    this.log.scrollTop = this.log.scrollHeight;
    this.fade();
  }

  /** Closed: lines new a while ago fade, then go (kept: shown again when it's opened). */
  private fade(): void {
    const now = performance.now();
    for (const row of Array.from(this.log.children) as HTMLElement[]) {
      const age = now - Number(row.dataset.at);
      const o = this.open ? 1 : age < ChatBox.SHOW_MS ? 1 : Math.max(0, 1 - (age - ChatBox.SHOW_MS) / ChatBox.FADE_MS);
      row.style.opacity = String(o);
      row.style.display = o > 0 ? '' : 'none';
    }
  }

  private showHint(): void {
    const command = this.input.value.startsWith('/');
    this.hint.hidden = false;
    this.hint.textContent = command
      ? '/msg <name> <message>: to one player (by radio) · /help'
      : this.hasRadio()
        ? 'by radio: everyone in this world with one hears you · Enter to send, Esc to stop'
        : 'no radio: only those near you hear you · Enter to send, Esc to stop';
  }
}

function span(text: string, cls: string): HTMLSpanElement {
  const s = document.createElement('span');
  s.textContent = text;
  s.className = cls;
  return s;
}
