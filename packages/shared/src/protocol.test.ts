import { describe, expect, it } from 'vitest';
import { MAX_CANCEL, PROTOCOL_VERSION, SEE_DEPTH, columnLayers, columnSpans, decodeClientMessage, encodeMessage, mergeSpans } from './protocol.js';

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

  it('validates cancels', () => {
    expect(decodeClientMessage('{"type":"cancel","chunks":[[1,-2,3]],"columns":[[-1,5]]}')).toEqual({ type: 'cancel', chunks: [[1, -2, 3]], columns: [[-1, 5]] });
    expect(decodeClientMessage('{"type":"cancel","tiles":[[2,0,0]]}')).toEqual({ type: 'cancel', tiles: [[2, 0, 0]] });
    expect(decodeClientMessage('{"type":"cancel"}')).toEqual({ type: 'cancel' });
    for (const raw of [
      '{"type":"cancel","chunks":[[1,2]]}',
      '{"type":"cancel","chunks":[[1,2,0.5]]}',
      '{"type":"cancel","columns":[[1,"2"]]}',
      '{"type":"cancel","tiles":{"0":[1,2,3]}}',
      `{"type":"cancel","columns":${JSON.stringify(Array.from({ length: MAX_CANCEL + 1 }, () => [0, 0]))}}`,
    ]) {
      expect(decodeClientMessage(raw)).toBeNull();
    }
  });

  it('names the chunk layers around a column surface', () => {
    // Ground from 0 to 1 m: the layer below (rounding) and layer 0.
    expect(columnLayers(0, 16)).toEqual({ lo: -1, hi: 0 });
    // Ground from 20 m to just under 47 m: layers 1 to 2; from 47 m (within 1 m of layer 3), 3 too.
    expect(columnLayers(20 * 16, 47 * 16 - 1)).toEqual({ lo: 1, hi: 2 });
    expect(columnLayers(20 * 16, 47 * 16)).toEqual({ lo: 1, hi: 3 });
  });

  it('renders the water surface and only the ground within sight below it', () => {
    const m = 16; // units per metre
    expect(SEE_DEPTH).toBe(96 * m);
    // Dry land: the whole range.
    expect(columnSpans({ minY: 20 * m, maxY: 30 * m })).toEqual([columnLayers(20 * m, 30 * m)]);
    // Shallow sea: floor and surface in one.
    expect(columnSpans({ minY: -20 * m, maxY: 0, solidTop: -18 * m, water: { min: 0, max: 0 } })).toEqual([{ lo: -2, hi: 0 }]);
    // Deep sea (floor 200 m down): just the surface.
    expect(columnSpans({ minY: -215 * m, maxY: 0, solidTop: -200 * m, water: { min: 0, max: 0 } })).toEqual([{ lo: -1, hi: 0 }]);
    // A slope from 150 m to 50 m down: the part above 96 m down, and the surface.
    const slope = { minY: -150 * m, maxY: 0, solidTop: -50 * m, water: { min: 0, max: 0 } };
    expect(columnSpans(slope)).toEqual([{ lo: -7, hi: -4 }, { lo: -1, hi: 0 }]);
    expect(columnSpans(slope, 40 * m)).toEqual(columnSpans(slope)); // above the water: the same
    // Swimming 150 m down: all of the slope (within 96 m of us), our own layer, and the surface.
    expect(columnSpans(slope, -150 * m)).toEqual([{ lo: -10, hi: -4 }, { lo: -1, hi: 0 }]);
    // Swimming 30 m down over the deep sea: our layer too (nothing else to draw there).
    expect(columnSpans({ minY: -215 * m, maxY: 0, solidTop: -200 * m, water: { min: 0, max: 0 } }, -30 * m)).toEqual([{ lo: -2, hi: 0 }]);
    // An islet (solid above the water): everything.
    expect(columnSpans({ minY: -150 * m, maxY: 12 * m, solidTop: 12 * m, water: { min: 0, max: 0 } })).toEqual([{ lo: -7, hi: 0 }]);
  });

  it('merges spans that overlap or touch', () => {
    expect(mergeSpans([{ lo: 5, hi: 6 }, { lo: -1, hi: 0 }, { lo: 1, hi: 2 }, { lo: 6, hi: 9 }])).toEqual([{ lo: -1, hi: 2 }, { lo: 5, hi: 9 }]);
    expect(mergeSpans([])).toEqual([]);
  });

  it('validates placing and using objects', () => {
    expect(decodeClientMessage('{"type":"placeObject","id":3,"item":1003,"x":-5,"y":2,"z":9,"facing":"e"}')).toEqual({ type: 'placeObject', id: 3, item: 1003, x: -5, y: 2, z: 9, facing: 'e' });
    expect(decodeClientMessage('{"type":"placeObject","id":3,"item":5000,"x":1,"y":2,"z":3,"facing":"n","offset":[8,0,12]}')).toEqual({ type: 'placeObject', id: 3, item: 5000, x: 1, y: 2, z: 3, facing: 'n', offset: [8, 0, 12] });
    expect(decodeClientMessage('{"type":"use","id":4,"x":-80,"y":33,"z":150}')).toEqual({ type: 'use', id: 4, x: -80, y: 33, z: 150 });
    for (const raw of [
      '{"type":"placeObject","id":3,"item":1003,"x":0,"y":0,"z":0,"facing":"up"}',
      '{"type":"placeObject","id":-1,"item":1003,"x":0,"y":0,"z":0,"facing":"n"}',
      '{"type":"placeObject","id":3,"item":1003,"x":0.5,"y":0,"z":0,"facing":"n"}',
      '{"type":"use","id":4,"x":1,"y":2}',
      // (Off the grid: 1/4 m steps within a block, along each axis.)
      '{"type":"placeObject","id":3,"item":5000,"x":0,"y":0,"z":0,"facing":"n","offset":[6,0,0]}',
      '{"type":"placeObject","id":3,"item":5000,"x":0,"y":0,"z":0,"facing":"n","offset":[16,0,0]}',
      '{"type":"placeObject","id":3,"item":5000,"x":0,"y":0,"z":0,"facing":"n","offset":[4,0]}',
      '{"type":"placeObject","id":3,"item":5000,"x":0,"y":0,"z":0,"facing":"n","offset":[-4,0,0]}',
    ]) {
      expect(decodeClientMessage(raw)).toBeNull();
    }
  });

  it("validates poses, with what's in hand and how many swings", () => {
    expect(decodeClientMessage('{"type":"pose","x":1,"y":2,"z":3,"yaw":0.5,"held":1031,"swings":7}')).toEqual({ type: 'pose', x: 1, y: 2, z: 3, yaw: 0.5, held: 1031, swings: 7 });
    expect(decodeClientMessage('{"type":"pose","x":1,"y":2,"z":3,"yaw":0.5}')).toEqual({ type: 'pose', x: 1, y: 2, z: 3, yaw: 0.5 });
    expect(decodeClientMessage('{"type":"pose","x":1,"y":2,"z":3,"yaw":0.5,"held":"bow"}')).toBeNull();
    expect(decodeClientMessage('{"type":"pose","x":1,"y":2,"z":3,"yaw":0.5,"swings":-1}')).toBeNull();
  });

  it('validates boats: putting one in, getting in, taking one, and moving it', () => {
    expect(decodeClientMessage('{"type":"boatLaunch","id":1,"x":10.5,"y":-3,"z":4,"yaw":1.2}')).toEqual({ type: 'boatLaunch', id: 1, x: 10.5, y: -3, z: 4, yaw: 1.2 });
    expect(decodeClientMessage('{"type":"boatBoard","id":2,"boat":7}')).toEqual({ type: 'boatBoard', id: 2, boat: 7 });
    expect(decodeClientMessage('{"type":"boatTake","id":3,"boat":7}')).toEqual({ type: 'boatTake', id: 3, boat: 7 });
    expect(decodeClientMessage('{"type":"boatMove","boat":7,"x":1,"y":2,"z":3,"yaw":0}')).toEqual({ type: 'boatMove', boat: 7, x: 1, y: 2, z: 3, yaw: 0 });
    expect(decodeClientMessage('{"type":"boatMove","boat":7,"x":1,"y":2,"z":3,"yaw":0,"leave":true}')).toEqual({ type: 'boatMove', boat: 7, x: 1, y: 2, z: 3, yaw: 0, leave: true });
    for (const raw of [
      '{"type":"boatLaunch","id":1,"x":"a","y":0,"z":0,"yaw":0}',
      '{"type":"boatBoard","id":2,"boat":-1}',
      '{"type":"boatTake","id":3}',
      '{"type":"boatMove","boat":7,"x":1,"y":2,"z":3}',
      '{"type":"boatMove","boat":7,"x":1,"y":2,"z":3,"yaw":0,"leave":"yes"}',
    ]) expect(decodeClientMessage(raw)).toBeNull();
  });

  it('validates buckets and sword sweeps', () => {
    expect(decodeClientMessage('{"type":"bucket","id":1,"x":2,"y":-3,"z":4,"fill":true}')).toEqual({ type: 'bucket', id: 1, x: 2, y: -3, z: 4, fill: true });
    expect(decodeClientMessage('{"type":"cut","id":2,"sword":1001,"x":2,"y":3,"z":4}')).toEqual({ type: 'cut', id: 2, sword: 1001, x: 2, y: 3, z: 4 });
    expect(decodeClientMessage('{"type":"bucket","id":1,"x":2,"y":3,"z":4,"fill":"yes"}')).toBeNull();
    expect(decodeClientMessage('{"type":"cut","id":2,"x":2,"y":3,"z":4}')).toBeNull();
  });

  it('validates attacks', () => {
    expect(decodeClientMessage('{"type":"attack","target":12,"weapon":1001}')).toEqual({ type: 'attack', target: 12, weapon: 1001 });
    expect(decodeClientMessage('{"type":"attack","target":12,"weapon":null}')).toEqual({ type: 'attack', target: 12, weapon: null });
    expect(decodeClientMessage('{"type":"fell","speed":17.5}')).toEqual({ type: 'fell', speed: 17.5 });
    expect(decodeClientMessage('{"type":"fell","speed":-1}')).toBeNull();
    expect(decodeClientMessage('{"type":"fell","speed":"fast"}')).toBeNull();
    expect(decodeClientMessage('{"type":"eat","item":1007}')).toEqual({ type: 'eat', item: 1007 });
    expect(decodeClientMessage('{"type":"eat","item":1.5}')).toBeNull();
    expect(decodeClientMessage('{"type":"attack","target":-1,"weapon":null}')).toBeNull();
    expect(decodeClientMessage('{"type":"attack","target":3}')).toBeNull();
  });

  it('validates craft requests', () => {
    expect(decodeClientMessage('{"type":"craft","recipe":"wooden-sword"}')).toEqual({ type: 'craft', recipe: 'wooden-sword' });
    for (const raw of ['{"type":"craft"}', '{"type":"craft","recipe":5}', '{"type":"craft","recipe":"Bad Id"}', `{"type":"craft","recipe":"${'a'.repeat(65)}"}`]) {
      expect(decodeClientMessage(raw)).toBeNull();
    }
  });

  it('validates throwing things away', () => {
    expect(decodeClientMessage('{"type":"discard","item":1001,"amount":2}')).toEqual({ type: 'discard', item: 1001, amount: 2 });
    for (const bad of ['{"type":"discard","item":1001,"amount":0}', '{"type":"discard","item":-1,"amount":2}', '{"type":"discard","item":1001,"amount":1.5}', '{"type":"discard","item":"x","amount":2}'])
      expect(decodeClientMessage(bad)).toBeNull();
  });

  it('validates hotbars', () => {
    const nine = [1, 2, null, null, null, null, null, null, null, 12]; // (ten slots: the name's from when there were nine)
    expect(decodeClientMessage(JSON.stringify({ type: 'setHotbar', hotbar: nine }))).toEqual({ type: 'setHotbar', hotbar: nine });
    for (const hotbar of [nine.slice(1), [...nine, 1], [1.5, ...nine.slice(1)], [-1, ...nine.slice(1)], ['1', ...nine.slice(1)], 'x']) {
      expect(decodeClientMessage(JSON.stringify({ type: 'setHotbar', hotbar }))).toBeNull();
    }
  });

  it('validates poses', () => {
    expect(decodeClientMessage('{"type":"pose","x":1.5,"y":-3,"z":200,"yaw":0.7,"extra":1}')).toEqual({ type: 'pose', x: 1.5, y: -3, z: 200, yaw: 0.7 });
    expect(decodeClientMessage('{"type":"pose","x":1,"y":2,"z":3}')).toBeNull();
    expect(decodeClientMessage('{"type":"pose","x":"1","y":2,"z":3,"yaw":0}')).toBeNull();
  });

  it('validates edits and drops unknown fields', () => {
    expect(decodeClientMessage('{"type":"edit","id":7,"edit":{"op":"remove","x":1,"y":-2,"z":3,"evil":1}}')).toEqual({
      type: 'edit', id: 7, edit: { op: 'remove', x: 1, y: -2, z: 3 },
    });
    expect(decodeClientMessage('{"type":"edit","id":0,"edit":{"op":"break","x":1,"y":2,"z":3,"pieceSize":4}}')).toMatchObject({ edit: { op: 'break', pieceSize: 4 } });
    expect(decodeClientMessage('{"type":"edit","id":1,"edit":{"op":"place","x":1,"y":2,"z":3,"size":5,"material":2}}')).toMatchObject({ edit: { op: 'place', size: 5, material: 2 } });
    expect(decodeClientMessage('{"type":"edit","id":2,"edit":{"op":"removeBox","x":1,"y":2,"z":3,"size":8}}')).toEqual({
      type: 'edit', id: 2, edit: { op: 'removeBox', x: 1, y: 2, z: 3, size: 8 },
    });
    for (const raw of [
      '{"type":"edit","id":-1,"edit":{"op":"remove","x":1,"y":2,"z":3}}',
      '{"type":"edit","id":1.5,"edit":{"op":"remove","x":1,"y":2,"z":3}}',
      '{"type":"edit","id":1,"edit":{"op":"explode","x":1,"y":2,"z":3}}',
      '{"type":"edit","id":1,"edit":{"op":"remove","x":1.5,"y":2,"z":3}}',
      '{"type":"edit","id":1,"edit":{"op":"break","x":1,"y":2,"z":3}}',
      '{"type":"edit","id":1,"edit":{"op":"place","x":1,"y":2,"z":3,"size":4}}',
      '{"type":"edit","id":1}',
    ]) {
      expect(decodeClientMessage(raw)).toBeNull();
    }
  });
});
