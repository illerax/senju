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

describe('macOS self-update', () => {
  it('finds the disk image for the architecture', async () => {
    const { macDiskImage } = await import('../src/shared/update');
    const asset = (name: string) => ({ name, browser_download_url: `https://example.com/${name}` });
    const release = { tag_name: 'v0.2.0', assets: [asset('Senju-0.2.0-mac-x64.dmg'), asset('Senju-0.2.0-mac-arm64.dmg'), asset('latest.yml')] };
    expect(macDiskImage(release, '0.2.0', 'arm64')).toBe('https://example.com/Senju-0.2.0-mac-arm64.dmg');
    expect(macDiskImage(release, '0.2.0', 'x64')).toBe('https://example.com/Senju-0.2.0-mac-x64.dmg');
    expect(macDiskImage({ tag_name: 'v0.2.0' }, '0.2.0', 'arm64')).toBeNull();
  });

  it('finds the app bundle of an executable', async () => {
    const { appBundle } = await import('../src/shared/update');
    expect(appBundle('/Applications/Senju.app/Contents/MacOS/Senju')).toBe('/Applications/Senju.app');
    expect(appBundle('/Users/me/Applications/My Apps/Senju.app/Contents/MacOS/Senju')).toBe('/Users/me/Applications/My Apps/Senju.app');
    expect(appBundle('/usr/lib/senju/senju')).toBeNull();
  });
});
