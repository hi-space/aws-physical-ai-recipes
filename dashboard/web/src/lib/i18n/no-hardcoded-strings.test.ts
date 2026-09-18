import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Every user-facing string must come from the message catalog so both locales stay complete. Korean text is easy to
 * detect mechanically; this guard fails when a component outside `src/lib/i18n/messages` still contains Hangul.
 */
const ROOTS = ['src/components', 'src/app'];
const HANGUL = /[ㄱ-ㆎ가-힣]/;

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.tsx?$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry) && !full.includes(`${path.sep}test-utils${path.sep}`)) yield full;
  }
}

describe('component sources', () => {
  it('contain no hard-coded Korean text (use useT/translate instead)', () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(path.resolve(process.cwd(), root))) {
        if (file.includes(`${path.sep}api${path.sep}`)) continue; // API route messages are covered by a follow-up (Accept-Language)
        const lines = readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, index) => {
          if (HANGUL.test(line)) offenders.push(`${path.relative(process.cwd(), file)}:${index + 1}: ${line.trim().slice(0, 80)}`);
        });
      }
    }
    expect(offenders, offenders.slice(0, 20).join('\n')).toEqual([]);
  });
});
