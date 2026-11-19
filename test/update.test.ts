import { describe, expect, it } from 'vitest';
import { isNewerVersion } from '../src/shared/update';

describe('isNewerVersion', () => {
  it('compares versions part by part', () => {
    expect(isNewerVersion('0.1.10', '0.1.9')).toBe(true);
    expect(isNewerVersion('v0.2.0', '0.1.9')).toBe(true);
    expect(isNewerVersion('1.0.0', '0.9.9')).toBe(true);
    expect(isNewerVersion('0.1.2', '0.1.2')).toBe(false);
    expect(isNewerVersion('0.1.1', '0.1.2')).toBe(false);
  });

  it('ignores pre-release and build suffixes', () => {
    expect(isNewerVersion('0.1.3-beta.1', '0.1.2')).toBe(true);
    expect(isNewerVersion('0.1.2+build.5', '0.1.2')).toBe(false);
  });
});
