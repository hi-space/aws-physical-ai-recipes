import { describe, expect, it } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Next.js refuses to start when two sibling dynamic segments use different slug names (e.g. `[node]` next to
 * `[nodeId]`). `next build` does not catch it; the ECS task then fails its health check and the deploy rolls back.
 */
function* dirs(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) { yield full; yield* dirs(full); }
  }
}
describe('app router dynamic segments', () => {
  it('use one slug name per directory level', () => {
    const offenders: string[] = [];
    for (const dir of [path.resolve(process.cwd(), 'src/app'), ...dirs(path.resolve(process.cwd(), 'src/app'))]) {
      const dynamic = readdirSync(dir).filter((e) => /^\[.+\]$/.test(e) && statSync(path.join(dir, e)).isDirectory());
      if (dynamic.length > 1) offenders.push(`${path.relative(process.cwd(), dir)}: ${dynamic.join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });
});
