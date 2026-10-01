// The browser mesh worker, run in a node worker thread for bench/fly.ts.
import { parentPort } from 'node:worker_threads';
import { register } from 'tsx/esm/api';
register();
const port = parentPort!;
(globalThis as unknown as { self: unknown }).self = {
  postMessage: (msg: unknown, transfer?: Transferable[]) => port.postMessage(msg, transfer as never),
  set onmessage(fn: (ev: { data: unknown }) => void) { port.on('message', (data) => fn({ data })); },
};
await import('../src/mesher.worker.ts');
