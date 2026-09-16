import WebSocket from 'ws';
import type { GatewaySession, GatewayTransport, TerminalConnection } from './types';

export async function serveTerminal(ws: WebSocket, session: GatewaySession, transport: GatewayTransport, controller: AbortController) {
  let connection: TerminalConnection | undefined;
  let pending: Array<{ type: 'input'; data: string } | { type: 'resize'; cols: number; rows: number }> = [];
  let pendingBytes = 0;
  const send = (message: object) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 1_048_576) { controller.abort(); return; }
    ws.send(JSON.stringify(message), (error) => { if (error) controller.abort(); });
  };
  const stop = () => {
    pending = [];
    connection?.close();
    if (ws.readyState === WebSocket.OPEN) ws.close(1008, 'Session ended');
    const timer = setTimeout(() => ws.terminate(), 1_000);
    timer.unref();
    ws.once('close', () => clearTimeout(timer));
  };
  controller.signal.addEventListener('abort', stop, { once: true });
  ws.once('close', () => { controller.abort(); controller.signal.removeEventListener('abort', stop); });
  ws.on('error', () => controller.abort());
  const dispatch = (message: (typeof pending)[number]) => {
    if (message.type === 'input') connection!.input(message.data);
    else connection!.resize(message.cols, message.rows);
  };
  ws.on('message', (raw, binary) => {
    try {
      const bytes = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);
      if (binary || bytes.length > 65_536) throw new Error();
      const message = JSON.parse(bytes.toString());
      if (!message || typeof message !== 'object') throw new Error();
      if (message.type === 'input') {
        if (typeof message.data !== 'string' || Buffer.byteLength(message.data) > 65_536 ||
          Object.keys(message).some((key) => !['type', 'data'].includes(key))) throw new Error();
      } else if (message.type === 'resize') {
        if (!Number.isInteger(message.cols) || !Number.isInteger(message.rows) ||
          message.cols < 1 || message.cols > 1000 || message.rows < 1 || message.rows > 1000 ||
          Object.keys(message).some((key) => !['type', 'cols', 'rows'].includes(key))) throw new Error();
      } else throw new Error();
      if (connection) dispatch(message);
      else {
        pendingBytes += bytes.length;
        if (pending.length >= 32 || pendingBytes > 65_536) throw new Error();
        pending.push(message);
      }
    } catch {
      send({ type: 'error', message: 'Invalid terminal message' });
      controller.abort();
    }
  });
  try {
    connection = await transport.exec(session, {
      stdout: (data) => send({ type: 'stdout', data }),
      stderr: (data) => send({ type: 'stderr', data }),
      exit: (code) => { send({ type: 'exit', code }); ws.close(1000, 'Terminal exited'); controller.abort(); },
      error: () => { send({ type: 'error', message: 'Terminal connection failed' }); controller.abort(); },
    }, controller.signal);
    if (controller.signal.aborted) { connection.close(); return; }
    for (const message of pending) dispatch(message);
    pending = [];
  } catch {
    send({ type: 'error', message: 'Terminal connection unavailable' });
    controller.abort();
  }
}

/** ANSI terminal assets are bundled locally by the parent service build. */
export const terminalPage = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Research task terminal</title>
<link rel="stylesheet" href="/__gateway/assets/terminal.css">
<style>html,body{height:100%;margin:0;background:#141820;color:#e7ebf1;font:14px ui-sans-serif,system-ui}body{display:flex;flex-direction:column}header{display:flex;align-items:center;gap:20px;padding:14px 20px;border-bottom:1px solid #354052}h1{font-size:14px;margin:0}#terminal-status{color:#b8c4d6;flex:1}button{background:#283447;color:#e7ebf1;border:1px solid #566782;border-radius:4px;padding:6px 10px}main{flex:1;min-height:0;padding:12px}#terminal{height:100%;width:100%}.xterm{height:100%}</style>
<script src="/__gateway/assets/terminal.js" defer></script></head>
<body><header><h1>Task terminal</h1><span id="terminal-status" role="status">Connecting…</span><button id="terminal-focus" type="button">Focus terminal</button></header>
<main><div id="terminal" aria-label="Research task terminal"></div></main></body></html>`;
