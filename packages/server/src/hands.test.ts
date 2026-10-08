import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { FLAT_WORLD_16KM, FlatGenerator, Item, PROTOCOL_VERSION, defaultFlatGen, type ServerMessage } from '@super-vox/shared';
import { buildApp } from './app.js';
import { World } from './world.js';
import { singleWorld } from './worlds.js';

describe("players' hands", () => {
  it("tell others what's in them, and how many times they've swung it", async () => {
    const world = new World(FLAT_WORLD_16KM, new FlatGenerator(FLAT_WORLD_16KM, defaultFlatGen(4)), {});
    const app = await buildApp({ catalog: singleWorld(world) });
    try {
      const base = await app.listen({ port: 0, host: '127.0.0.1' });
      const join = async () => {
        const ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws');
        const msgs: ServerMessage[] = [];
        ws.on('message', (d, bin) => !bin && msgs.push(JSON.parse(String(d)) as ServerMessage));
        await new Promise((r) => ws.once('open', r));
        ws.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION }));
        return { ws, msgs };
      };
      const until = async (f: () => boolean) => {
        for (let i = 0; i < 300 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
        if (!f()) throw new Error(`timed out: ${f.toString().slice(0, 100)}`);
      };
      const ann = await join(), bob = await join();
      await until(() => ann.msgs.some((m) => m.type === 'welcome') && bob.msgs.some((m) => m.type === 'welcome'));
      bob.ws.send(JSON.stringify({ type: 'pose', x: 1600, y: 26, z: 1700, yaw: 0 }));
      ann.ws.send(JSON.stringify({ type: 'pose', x: 1600, y: 26, z: 1600, yaw: 0, held: Item.Bow, swings: 2 }));
      const annSeen = () =>
        bob.msgs
          .filter((m): m is Extract<ServerMessage, { type: 'entities' }> => m.type === 'entities')
          .at(-1)
          ?.entities.find((e) => e.kind === 'player' && e.z === 1600);
      await until(() => annSeen()?.held === Item.Bow);
      expect(annSeen()).toMatchObject({ held: Item.Bow, swings: 2 });
      // Put away, swung again: so.
      ann.ws.send(JSON.stringify({ type: 'pose', x: 1600, y: 26, z: 1600, yaw: 0.1, swings: 3 }));
      await until(() => annSeen()?.swings === 3);
      expect(annSeen()!.held).toBeUndefined();
      ann.ws.close();
      bob.ws.close();
    } finally {
      await app.close();
    }
  });
});
