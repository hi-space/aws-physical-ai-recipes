import { expect, it } from 'vitest';
import { SecretRedactor } from './redaction';
it('redacts exact secrets across all chunk boundaries while preserving arbitrary text and URLs', () => {
  const original = 'same\nsame\n\nhttps://host/log?token=not-a-secret secret-value done\n';
  for (let cut = 0; cut <= original.length; cut++) {
    const redactor = new SecretRedactor(['secret-value']);
    const result = Buffer.concat([redactor.push(Buffer.from(original.slice(0, cut))), redactor.push(Buffer.from(original.slice(cut))), redactor.finish()]);
    expect(result.toString()).toBe('same\nsame\n\nhttps://host/log?token=not-a-secret [REDACTED] done\n');
  }
});
it('preserves binary bytes and split Unicode when no secret matches', () => {
  const r = new SecretRedactor(['very-long-private-value']), raw = Buffer.concat([Buffer.from('한글\n'), Buffer.from([0, 255])]);
  const out = [...raw].map(byte => r.push(Buffer.from([byte])));out.push(r.finish());expect(Buffer.concat(out)).toEqual(raw);
});
it('immediately flushes unrelated short live logs even with a long injected secret', () => {
  const r = new SecretRedactor(['eyJ' + 'X'.repeat(600) + '.signature']);
  const log = Buffer.from('training started\n' + 'step complete '.repeat(16) + '\n');
  expect(log.length).toBeLessThan(600);
  expect(r.push(log)).toEqual(log); // No second chunk or EOF is needed during a quiet job.
  expect(r.finish()).toEqual(Buffer.alloc(0));
});
it('retains only a possible secret-prefix suffix and flushes it when the next bytes rule it out', () => {
  const r = new SecretRedactor(['abcdef', 'ababc']);
  expect(r.push(Buffer.from('ready\naba')).toString()).toBe('ready\n');
  expect(r.push(Buffer.from('X\n')).toString()).toBe('abaX\n');
  expect(r.finish().length).toBe(0);
});
it('redacts a long secret across every split while flushing unrelated prefixes and following output', () => {
  const secret = 'eyJ' + 'X'.repeat(600) + '.signature';
  for (let cut = 1; cut < secret.length; cut++) {
    const r = new SecretRedactor([secret]);
    expect(r.push(Buffer.from('ready\n' + secret.slice(0, cut))).toString()).toBe('ready\n');
    expect(r.push(Buffer.from(secret.slice(cut) + '\nnext\n')).toString()).toBe('[REDACTED]\nnext\n');
    expect(r.finish().length).toBe(0);
  }
});
it('waits for a longer secret when a complete shorter secret is its prefix', () => {
  for (const values of [['abc', 'abcdef'], ['abcdef', 'abc']]) {
    const r = new SecretRedactor(values);
    expect(r.push(Buffer.from('abc')).length).toBe(0);
    expect(r.push(Buffer.from('def\n')).toString()).toBe('[REDACTED]\n');
    expect(r.push(Buffer.from('abc')).length).toBe(0);
    expect(r.push(Buffer.from('X\n')).toString()).toBe('[REDACTED]X\n');
    expect(r.push(Buffer.from('abc')).length).toBe(0);
    expect(r.finish().toString()).toBe('[REDACTED]');
  }
});
it('preserves leftmost matching when a pending prefix contains a later complete secret', () => {
  const r = new SecretRedactor(['ababa', 'bab']);
  expect(r.push(Buffer.from('abab')).length).toBe(0);
  expect(r.push(Buffer.from('X\n')).toString()).toBe('a[REDACTED]X\n');
  expect(r.push(Buffer.from('ababa')).toString()).toBe('[REDACTED]');
  expect(r.finish().length).toBe(0);
});
it('preserves unmatched partial prefixes at EOF and handles one-byte secrets immediately', () => {
  const r = new SecretRedactor(['secret', '!']);
  expect(r.push(Buffer.from('done! sec')).toString()).toBe('done[REDACTED] ');
  expect(r.finish().toString()).toBe('sec');
});
