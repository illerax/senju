// An AppImage runs from a temporary mount ($TMPDIR/.mount_<name><random>),
// and its AppRun puts that mount on LD_LIBRARY_PATH, PATH, XDG_DATA_DIRS and
// the like. An app started by an AppImage, as an updated Senju is by the old
// one, inherits those entries, and any shell started from it would load
// libraries from a mount of another program that goes away when it quits.

/** A path inside an AppImage mount. */
const mountPath = /(^|\/)\.mount_[^/]+(\/|$)/;

/**
 * The environment without list entries pointing into an AppImage mount (or
 * into `appDir`); a variable left empty is removed. Windows has no AppImages,
 * and its paths contain the ':' that separates entries on Unix.
 */
export function withoutAppImagePaths<T extends Record<string, string | undefined>>(env: T, appDir?: string): T {
  if (process.platform === 'win32') return env;
  const inMount = (part: string) => mountPath.test(part) || (!!appDir && (part === appDir || part.startsWith(`${appDir}/`)));
  const result: Record<string, string | undefined> = { ...env };
  for (const [key, value] of Object.entries(env)) {
    if (!value) continue;
    const parts = value.split(':');
    if (!parts.some(inMount)) continue;
    const kept = parts.filter((part) => part && !inMount(part));
    if (kept.length) result[key] = kept.join(':');
    else delete result[key];
  }
  return result as T;
}
