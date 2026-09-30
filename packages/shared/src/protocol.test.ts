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

  it('validates chunk requests', () => {
    expect(decodeClientMessage('{"type":"requestChunk","cx":1,"cy":-2,"cz":3}')).toEqual({
      type: 'requestChunk', cx: 1, cy: -2, cz: 3,
    });
    for (const raw of [
      '{"type":"requestChunk","cx":1,"cy":2}',
      '{"type":"requestChunk","cx":1.5,"cy":2,"cz":3}',
      '{"type":"requestChunk","cx":"1","cy":2,"cz":3}',
      '{"type":"requestChunk","cx":1e20,"cy":2,"cz":3}',
    ]) {
      expect(decodeClientMessage(raw)).toBeNull();
    }
  });

  it('accepts an optional integer tolerance 0..16 in hello', () => {
    expect(decodeClientMessage('{"type":"hello","protocolVersion":5,"tolerance":0}')).toEqual({ type: 'hello', protocolVersion: 5, tolerance: 0 });
    expect(decodeClientMessage('{"type":"hello","protocolVersion":5,"tolerance":16}')).toEqual({ type: 'hello', protocolVersion: 5, tolerance: 16 });
    for (const t of ['-1', '17', '2.5', '"4"', 'null', '1e9']) {
      expect(decodeClientMessage(`{"type":"hello","protocolVersion":5,"tolerance":${t}}`)).toBeNull();
    }
  });

  it('validates tile and column requests', () => {
    expect(decodeClientMessage('{"type":"requestTile","level":3,"tx":-4,"tz":9}')).toEqual({ type: 'requestTile', level: 3, tx: -4, tz: 9 });
    expect(decodeClientMessage('{"type":"requestColumn","cx":5,"cz":-6}')).toEqual({ type: 'requestColumn', cx: 5, cz: -6 });
    for (const raw of [
      '{"type":"requestTile","level":0,"tx":0,"tz":0}',
      '{"type":"requestTile","level":7,"tx":0,"tz":0}',
      '{"type":"requestTile","level":2,"tx":0.5,"tz":0}',
      '{"type":"requestColumn","cx":1}',
    ]) {
      expect(decodeClientMessage(raw)).toBeNull();
    }
  });
});
