import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { CliTransport } from './runtime-common.js';

const messageLimit = 2_000_000;
const trafficLimit = 64_000_000;

/** Adapt one app-server environment connection to the already isolated guest process. */
export async function startProjectExecutorBridge(start: () => CliTransport) {
  let transport: CliTransport | undefined;
  const capability = randomBytes(32).toString('base64url');
  const credential = Buffer.from('Bearer ' + capability);
  const http = createServer({ headersTimeout: 5000, requestTimeout: 5000, maxHeaderSize: 8192 },
    (_request, response) => { response.writeHead(404, { Connection: 'close' }); response.end(); });
  const sockets = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: messageLimit });
  http.maxConnections = 16;
  http.setTimeout(5000, socket => socket.destroy());
  let peer: WebSocket | undefined;
  let closed = false;
  let guestExited = false;
  let pending = '';
  let traffic = 0;

  function close() {
    if (closed) return;
    closed = true;
    pending = '';
    peer?.terminate();
    sockets.close();
    http.close();
    http.closeAllConnections();
    if (!guestExited) transport?.kill('SIGTERM');
  }

  function account(bytes: number) {
    traffic += bytes;
    return traffic <= trafficLimit;
  }

  function checkObject(text: string) {
    const message: unknown = JSON.parse(text);
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('无效的执行器消息。');
  }

  try {
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(0, '127.0.0.1', () => { http.off('error', reject); resolve(); });
    });
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('无法连接本次项目执行器。');
    const authority = '127.0.0.1:' + address.port;
    http.on('error', close);
    http.on('upgrade', (request, socket, head) => {
      const supplied = Buffer.from(request.headers.authorization ?? '');
      if (closed || peer || request.socket.remoteAddress !== '127.0.0.1' || request.headers.host !== authority ||
          request.url !== '/' || request.headers.origin !== undefined || supplied.length !== credential.length ||
          !timingSafeEqual(supplied, credential)) { socket.destroy(); return; }
      sockets.handleUpgrade(request, socket, head, ws => {
        peer = ws;
        // A closed client may never attach again, even with the same capability.
        http.close();
        ws.on('close', close);
        ws.on('error', close);
        ws.on('message', (raw, binary) => {
          if (closed) return;
          if (binary || !Buffer.isBuffer(raw) || !account(raw.length)) { close(); return; }
          try {
            const text = raw.toString('utf8');
            checkObject(text);
            // Newlines inside a pretty-printed object must never split the guest's JSONL framing.
            transport!.write(text.replace(/[\r\n]/g, ' ') + '\n');
          } catch { close(); }
        });
      });
    });
    // Only start the guest after the listener exists. A failed bind must not
    // leave an unobserved VM child or consume the project's exclusive lease.
    transport = start();
    transport.connect(chunk => {
      if (closed) return;
      if (!peer || !account(Buffer.byteLength(chunk))) { close(); return; }
      try {
        pending += chunk;
        let end: number;
        while ((end = pending.indexOf('\n')) !== -1) {
          const text = pending.slice(0, end);
          pending = pending.slice(end + 1);
          if (Buffer.byteLength(text) > messageLimit || peer.bufferedAmount > messageLimit) { close(); return; }
          checkObject(text);
          peer.send(text, error => { if (error) close(); });
        }
        if (Buffer.byteLength(pending) > messageLimit) close();
      } catch { close(); }
    }, () => { guestExited = true; close(); }, close);
    if (closed) throw new Error('本次项目执行器已关闭。');
    return { url: 'ws://' + authority + '/', capability, close };
  } catch (error) {
    close();
    throw error;
  }
}
