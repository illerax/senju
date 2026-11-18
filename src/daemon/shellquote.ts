/** Quotes an argument for a POSIX shell. */
export function quote(arg: string): string {
  if (arg !== '' && /^[\w@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function quoteArgs(argv: string[]): string {
  return argv.map(quote).join(' ');
}

/** Environment variables that describe the shell session rather than the user's setup. */
const volatileEnv = new Set(['_', 'OLDPWD', 'PWD', 'SHLVL', 'LINES', 'COLUMNS', 'TERM', 'COLORTERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'SENJU_PANE_ID']);

/** Variables of `env` that are missing from or differ in `base`. */
export function envDiff(env: Record<string, string>, base: Record<string, string | undefined>): Record<string, string> {
  const diff: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!volatileEnv.has(key) && base[key] !== value) diff[key] = value;
  }
  return diff;
}
