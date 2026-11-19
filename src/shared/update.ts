/** What the updater is doing, shown in the banner and in Settings → About. */
export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'unsupported'; reason: string }
  | { state: 'checking' }
  | { state: 'current'; checkedAt: number }
  /** `manual`: the app cannot install it itself and opens `url` instead. */
  | { state: 'available'; version: string; url: string; manual: boolean }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string };

export type UpdateAction = 'check' | 'download' | 'install' | 'dismiss';

/** Whether release `candidate` is newer than `current`; both are "x.y.z", optionally with a "v" and a pre-release suffix. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split(/[-+]/)[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
  const a = parse(candidate);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

/** A release as the GitHub API describes it; only the fields the updater reads. */
export interface ReleaseInfo {
  tag_name?: string;
  assets?: { name: string; browser_download_url: string }[];
}

/** The download URL of the macOS disk image for an architecture, named as `artifactName` in package.json does. */
export function macDiskImage(release: ReleaseInfo, version: string, arch: string): string | null {
  const name = `Senju-${version}-mac-${arch}.dmg`;
  return release.assets?.find((asset) => asset.name === name)?.browser_download_url ?? null;
}

/** The .app bundle an executable runs from (…/Senju.app/Contents/MacOS/Senju), or null. */
export function appBundle(executable: string): string | null {
  const match = /^(.+\.app)\/Contents\/MacOS\/[^/]+$/.exec(executable);
  return match ? match[1] : null;
}
