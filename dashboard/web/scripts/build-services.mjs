import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

await mkdir('dist/gateway-assets', { recursive: true });
await Promise.all([
  build({ entryPoints: ['src/worker.ts'], bundle: true, platform: 'node', target: 'node22', format: 'cjs', outfile: 'dist/services/controller.cjs' }),
  build({ entryPoints: ['src/gateway.ts'], bundle: true, platform: 'node', target: 'node22', format: 'cjs', outfile: 'dist/services/gateway.cjs' }),
  build({ entryPoints: ['src/server/gateway/browser/terminal-client.js'], bundle: true, platform: 'browser', target: 'es2022', format: 'iife', outfile: 'dist/gateway-assets/terminal.js' }),
  copyFile('node_modules/@xterm/xterm/css/xterm.css', 'dist/gateway-assets/terminal.css'),
]);
