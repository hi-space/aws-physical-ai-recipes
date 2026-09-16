import { expect, it } from 'vitest';
import { normalizeSelection, pathSelected } from './selection';
it('matches exact files and directory prefixes, with explicit excludes taking precedence', () => {
  const s = normalizeSelection({ include: ['train/', 'labels.json'], exclude: ['train/private/', 'train/tmp.bin'] });
  expect(['train/a.bin','labels.json','train/private/a','train/tmp.bin','trainish/a','other'].map(p => pathSelected(p,s))).toEqual([true,true,false,false,false,false]);
  expect(pathSelected('any/file',normalizeSelection({}))).toBe(true);
});
it.each(['../escape','a/../b','/absolute','a\\b','a//b','manifest.json','.pai/input','a/.pai-input-receipt.json','x\u0000y','a/*','s3://bucket/key'])('rejects ambiguous or unsafe selection %s', path => {
  expect(() => normalizeSelection({include:[path]})).toThrow();
});
