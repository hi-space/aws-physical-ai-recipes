import { describe, it, expect } from 'vitest';
import { PORT_KINDS, isPortKind } from './ports';

describe('PortKind', () => {
  it('includes all expected kinds', () => {
    expect(PORT_KINDS).toContain('lerobot-dataset');
    expect(PORT_KINDS).toContain('checkpoint');
    expect(PORT_KINDS).toContain('artifacts');
    expect(PORT_KINDS.length).toBe(6);
  });
  it('isPortKind guards correctly', () => {
    expect(isPortKind('checkpoint')).toBe(true);
    expect(isPortKind('invalid')).toBe(false);
    expect(isPortKind(undefined)).toBe(false);
  });
});
