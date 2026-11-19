import { describe, expect, it } from 'vitest';
import { withoutAppImagePaths } from '../src/shared/env';

describe('withoutAppImagePaths', () => {
  it('drops entries in any AppImage mount, not only its own', () => {
    const env = {
      LD_LIBRARY_PATH: '/tmp/.mount_senjurn75lc/usr/lib:/tmp/.mount_senjuPHc7qf/usr/lib',
      PATH: '/tmp/.mount_senjuWAscx2:/home/me/bin:/usr/bin',
      __MISE_ORIG_PATH: '/home/me/bin:/tmp/.mount_senjuPHc7qf/usr/bin:/usr/bin',
      XDG_DATA_DIRS: '/tmp/.mount_senjuWAscx2/usr/share/:/usr/share',
      HOME: '/home/me',
    };
    expect(withoutAppImagePaths(env)).toEqual({
      PATH: '/home/me/bin:/usr/bin',
      __MISE_ORIG_PATH: '/home/me/bin:/usr/bin',
      XDG_DATA_DIRS: '/usr/share',
      HOME: '/home/me',
    });
  });

  it('drops entries in the given app folder, which an extracted AppImage has instead of a mount', () => {
    const env = { PATH: '/tmp/appimage_extracted_1/usr/bin:/usr/bin', OTHER: '/tmp/appimage_extracted_10/x' };
    expect(withoutAppImagePaths(env, '/tmp/appimage_extracted_1')).toEqual({ PATH: '/usr/bin', OTHER: '/tmp/appimage_extracted_10/x' });
  });

  it('leaves values without mount entries alone', () => {
    const env = { URL: 'https://example.com:8080/a', EMPTY: '', PATH: '/usr/bin::/bin', NAME: 'my.mount_point' };
    expect(withoutAppImagePaths(env)).toEqual(env);
  });
});
