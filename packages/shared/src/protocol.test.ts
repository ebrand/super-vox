import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, decodeClientMessage, encodeMessage } from './protocol.js';

describe('protocol', () => {
  it('round-trips hello', () => {
    const raw = encodeMessage({ type: 'hello', protocolVersion: PROTOCOL_VERSION });
    expect(decodeClientMessage(raw)).toEqual({ type: 'hello', protocolVersion: PROTOCOL_VERSION });
  });

  it('rejects malformed client input', () => {
    for (const raw of ['', 'not json', 'null', '42', '{}', '{"type":"hello"}', '{"type":"nope"}']) {
      expect(decodeClientMessage(raw)).toBeNull();
    }
  });

  it('drops unknown fields from client messages', () => {
    const msg = decodeClientMessage('{"type":"hello","protocolVersion":1,"admin":true}');
    expect(msg).toEqual({ type: 'hello', protocolVersion: 1 });
  });
});
