// Use the dashboard's existing esbuild dependency; install/change no web dependencies.
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const web = path.join(root, 'dashboard/web');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-lease-check-'));
try {
  const output = path.join(temporary, 'check.cjs');
  require(path.join(web, 'node_modules/esbuild')).buildSync({
    entryPoints: [path.join(__dirname, 'virtual_lease_check.ts')], outfile: output,
    bundle: true, platform: 'node', packages: 'external',
    nodePaths: [path.join(web, 'node_modules')],
    alias: { '@': path.join(web, 'src') },
  });
  execFileSync(process.execPath, [output], { stdio: 'inherit', env: { ...process.env, NODE_PATH: path.join(web, 'node_modules') } });
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
