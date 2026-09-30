import {
  PROTOCOL_VERSION,
  decodeServerMessage,
  encodeMessage,
  type ServerMessage,
} from '@super-vox/shared';

export function connect(onMessage: (msg: ServerMessage) => void, onClose: () => void): WebSocket {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${scheme}://${location.host}/ws`);
  ws.addEventListener('open', () => {
    ws.send(encodeMessage({ type: 'hello', protocolVersion: PROTOCOL_VERSION }));
  });
  ws.addEventListener('message', (ev) => {
    const msg = typeof ev.data === 'string' ? decodeServerMessage(ev.data) : null;
    if (msg) onMessage(msg);
  });
  ws.addEventListener('close', onClose);
  return ws;
}
