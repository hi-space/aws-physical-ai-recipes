import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { GatewayError } from './types';

export async function terminalAsset(name: 'terminal.js' | 'terminal.css', directory?: string): Promise<Buffer> {
  const root = directory ?? process.env.GATEWAY_ASSET_DIR ?? resolve(process.cwd(), 'dist/gateway-assets');
  try { return await readFile(resolve(root, name)); }
  catch { throw new GatewayError(503, 'Terminal assets are not installed in this gateway build'); }
}
