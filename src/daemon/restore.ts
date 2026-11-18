// Decides how a terminal's program comes back when its process did not survive:
// resume an agent session, restart the command, or offer a "Run again" button.

import path from 'node:path';
import type { JobState, TerminalState, PendingCommand } from '../shared/types';
import { matchRecipe, programOf, resumeCommand, type Recipe } from './recipes';
import { quote, quoteArgs } from './shellquote';

export interface RestorePlan {
  /** Variables added to the new shell, so the restored program sees the environment it had. */
  env?: Record<string, string>;
  /** Typed into the new shell right away. */
  command?: string;
  /** Shown with a "Run again" button. */
  pending?: PendingCommand;
}

/** Command line used to match against the auto-restart list, with program paths shortened. */
export function displayCommand(argv: string[]): string {
  const { program, args } = programOf(argv);
  const name = path.basename(program).replace(/(-cli)?\.(c|m)?js$/, '');
  return quoteArgs([name, ...args]);
}

function cdPrefix(job: JobState, shellCwd: string): string {
  return job.cwd && job.cwd !== shellCwd ? `cd ${quote(job.cwd)} && ` : '';
}

/** Search paths are rebuilt by the shell's startup files; passing them on would only duplicate entries. */
const shellManaged = /^(PATH|MANPATH|INFOPATH|FPATH)$/;

function jobEnv(job: JobState): Record<string, string> {
  return Object.fromEntries(Object.entries(job.env).filter(([key]) => !shellManaged.test(key)));
}

export function planRestore(
  terminal: TerminalState,
  recipes: Recipe[],
  autoRestart: string[],
  baseEnv: Record<string, string | undefined>,
): RestorePlan {
  const job = terminal.job;
  if (!job) return terminal.pending ? { pending: terminal.pending } : {};

  const env = { ...baseEnv, ...terminal.env, ...job.env };
  const recipe = (job.recipe && recipes.find((r) => r.name === job.recipe)) || matchRecipe(recipes, job.argv, job.cwd);
  if (recipe) {
    const resume = resumeCommand(recipe, job.argv, job.cwd, env, job.sessionId);
    if (resume) return { env: jobEnv(job), command: cdPrefix(job, terminal.cwd) + resume };
  }

  const command = cdPrefix(job, terminal.cwd) + quoteArgs(job.argv);
  const shown = displayCommand(job.argv);
  const auto = autoRestart.some((pattern) => {
    try {
      const re = new RegExp(pattern);
      return re.test(shown) || re.test(quoteArgs(job.argv));
    } catch {
      return false;
    }
  });
  return auto ? { env: jobEnv(job), command } : { env: jobEnv(job), pending: { command, cwd: job.cwd || terminal.cwd } };
}
