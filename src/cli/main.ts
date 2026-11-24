// Entry of the `senju` command, run with Electron as Node.

import { run } from './run';

void run(process.argv.slice(2)).then((code) => process.exit(code));
