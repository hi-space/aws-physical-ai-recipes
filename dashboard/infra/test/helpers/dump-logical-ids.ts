import * as fs from 'node:fs';
import * as path from 'node:path';
import { logicalIds, synthesize } from './synth';
const out = path.resolve(__dirname, '../fixtures/default-logical-ids.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(logicalIds(synthesize()), null, 2) + '\n');
console.log(`wrote ${out}`);
