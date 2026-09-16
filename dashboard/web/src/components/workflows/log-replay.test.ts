import { expect, it } from 'vitest';
import { LogReplay } from './log-replay';
const record = (sequence: number, text: string) => ({ sequence, kind: 'data', data: Buffer.from(text).toString('base64') });
const page = (records: unknown[], cursor: string = 'a'.repeat(43)) => ({ source: 'archive', stream: { id: '1'.repeat(64), sequence: 5 }, records, cursor });
it('applies repeated/blank/URL lines once by sequence and resumes without clearing on replay', () => {
  const replay = new LogReplay();
  replay.apply(page([record(1, 'same\nsame\n\n'), record(2, 'https://example.test\n')]));
  replay.apply(page([record(2, 'https://example.test\n'), record(3, 'last')], 'b'.repeat(43)));
  expect(replay.text).toBe('same\nsame\n\nhttps://example.test\nlast');
  expect(replay.cursor).toBe('b'.repeat(43));
});
it('rejects a missing sequence or changed stream before advancing its cursor', () => {
  const replay = new LogReplay();
  replay.apply(page([record(1, 'first')]));
  expect(() => replay.apply(page([record(3, 'skipped')], 'b'.repeat(43)))).toThrow();
  expect(() => replay.apply({ ...page([record(2, 'wrong')]), stream: { id: '2'.repeat(64) } })).toThrow();
  expect(replay.cursor).toBe('a'.repeat(43)); expect(replay.text).toBe('first');
});
it('accepts explicit tail position and keeps coverage gaps separate from arbitrary log text', () => {
  const replay = new LogReplay();
  replay.apply(page([{ sequence: 42, kind: 'gap', reason: 'source-reconnect' }, record(43, 'line')]));
  expect(replay.text).toBe('line'); expect(replay.gaps).toEqual(['source-reconnect']);
});
it('bounds display while retaining the opaque archive position', () => {
  const replay = new LogReplay();
  for (let i = 1; i <= 100; i++) replay.apply(page([record(i, 'x'.repeat(16000))]));
  expect(replay.text.length).toBeLessThanOrEqual(1024 * 1024); expect(replay.truncated).toBe(true);
});
