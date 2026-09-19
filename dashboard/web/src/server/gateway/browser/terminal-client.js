import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

const status = document.getElementById('terminal-status');
const mount = document.getElementById('terminal');
const terminal = new Terminal({ cursorBlink: true, disableStdin: true, scrollback: 5000,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 14,
  theme: { background: '#141820', foreground: '#e7ebf1', cursor: '#ffb454', selectionBackground: '#35465f' } });
const fit = new FitAddon();
terminal.loadAddon(fit);
terminal.open(mount);
// Relative to the current page so the session prefix (path mode) is preserved; host mode resolves to root.
const endpoint = new URL('__gateway/terminal', location.href);
endpoint.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(endpoint);
let exited = false;
let pendingOutput = 0;
const send = (message) => {
  if (ws.readyState !== WebSocket.OPEN) return;
  if (ws.bufferedAmount > 1_048_576) { status.textContent = 'Input buffer full. Relaunch the session.'; ws.close(); return; }
  ws.send(JSON.stringify(message));
};
function resize() {
  if (!mount.clientWidth || !mount.clientHeight) return;
  fit.fit();
}
terminal.onResize(({ cols, rows }) => send({ type: 'resize', cols: Math.min(1000, cols), rows: Math.min(1000, rows) }));
terminal.onData((data) => {
  // Bound frame size and preserve Unicode surrogate pairs during large pastes.
  let start = 0;
  while (start < data.length) {
    let end = Math.min(start + 8192, data.length);
    if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1])) end--;
    send({ type: 'input', data: data.slice(start, end) });
    start = end;
  }
});
const observer = new ResizeObserver(() => requestAnimationFrame(resize));
observer.observe(mount);
ws.onopen = () => {
  status.textContent = 'Connected'; terminal.options.disableStdin = false; resize();
  send({ type: 'resize', cols: Math.min(1000, terminal.cols), rows: Math.min(1000, terminal.rows) }); terminal.focus();
};
ws.onmessage = (event) => {
  try {
    const message = JSON.parse(event.data);
    if ((message.type === 'stdout' || message.type === 'stderr') && typeof message.data === 'string') {
      pendingOutput += message.data.length;
      if (pendingOutput > 4_194_304) { status.textContent = 'Output buffer full. Relaunch the session.'; ws.close(); return; }
      terminal.write(message.data, () => { pendingOutput -= message.data.length; });
    } else if (message.type === 'exit') {
      exited = true; status.textContent = `Exited (${message.code})`; terminal.options.disableStdin = true;
    } else if (message.type === 'error') {
      status.textContent = message.message || 'Terminal connection failed';
    }
  } catch { status.textContent = 'Invalid terminal response'; ws.close(); }
};
ws.onerror = () => { status.textContent = 'Terminal connection failed. Relaunch from the dashboard.'; };
ws.onclose = () => {
  terminal.options.disableStdin = true;
  if (!exited) status.textContent = 'Session closed. Relaunch from the dashboard to reconnect.';
};
document.getElementById('terminal-focus').onclick = () => terminal.focus();
addEventListener('pagehide', () => { observer.disconnect(); ws.close(); terminal.dispose(); }, { once: true });
