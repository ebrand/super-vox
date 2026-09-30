import {
  BinaryTag,
  PROTOCOL_VERSION,
  decodeServerMessage,
  encodeMessage,
  type ClientMessage,
  type ServerMessage,
} from '@super-vox/shared';

export interface ConnectionHandlers {
  /** Extra hello fields, e.g. a development tolerance override. */
  hello?: { tolerance?: number };
  onMessage: (msg: ServerMessage) => void;
  onChunk: (bytes: Uint8Array) => void;
  onTile: (bytes: Uint8Array) => void;
  onClose: () => void;
}

export interface Connection {
  send: (msg: ClientMessage) => void;
}

export function connect(handlers: ConnectionHandlers): Connection {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${scheme}://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';
  ws.addEventListener('open', () => {
    ws.send(encodeMessage({ type: 'hello', protocolVersion: PROTOCOL_VERSION, ...handlers.hello }));
  });
  ws.addEventListener('message', (ev) => {
    if (ev.data instanceof ArrayBuffer) {
      const frame = new Uint8Array(ev.data);
      if (frame[0] === BinaryTag.Chunk) handlers.onChunk(frame.subarray(1));
      else if (frame[0] === BinaryTag.Tile) handlers.onTile(frame.subarray(1));
      return;
    }
    const msg = typeof ev.data === 'string' ? decodeServerMessage(ev.data) : null;
    if (msg) handlers.onMessage(msg);
  });
  ws.addEventListener('close', handlers.onClose);
  return {
    send: (msg) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(encodeMessage(msg));
    },
  };
}
