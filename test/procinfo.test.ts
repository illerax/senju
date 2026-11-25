import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openFiles, parseLsofCwd, parseLsofNames, parsePs } from '../src/daemon/procinfo';

describe('macOS process inspection', () => {
  it('parses ps output with process groups and arguments', () => {
    const processes = parsePs(['  501   501   812 -zsh', '  812   812   812 node /opt/claude/cli.js --resume', ' 900   900     0 ', ''].join('\n'));
    expect(processes.get(501)).toEqual({ pgid: 501, tpgid: 812, argv: ['-zsh'] });
    expect(processes.get(812)?.argv).toEqual(['node', '/opt/claude/cli.js', '--resume']);
    expect(processes.get(900)).toEqual({ pgid: 900, tpgid: 0, argv: [] });
  });

  it('parses the working directories of several processes from one lsof run', () => {
    const cwds = parseLsofCwd(['p501', 'fcwd', 'n/Users/me/project', 'p812', 'fcwd', 'n/Users/me/with space', ''].join('\n'));
    expect(cwds).toEqual(new Map([[501, '/Users/me/project'], [812, '/Users/me/with space']]));
  });

  it('parses the open files of a process', () => {
    expect(parseLsofNames(['p812', 'fcwd', 'n/Users/me/project', 'f12', 'n/Users/me/.gemini/x.lock', ''].join('\n'))).toEqual(['/Users/me/project', '/Users/me/.gemini/x.lock']);
  });
});

describe('open files', () => {
  it.runIf(process.platform === 'linux')('lists the files a process keeps open', async () => {
    const file = path.join(os.tmpdir(), `senju-open-${process.pid}.lock`);
    const handle = await fs.promises.open(file, 'w');
    try {
      expect(await openFiles(process.pid)).toContain(file);
    } finally {
      await handle.close();
      await fs.promises.rm(file);
    }
    expect(await openFiles(2 ** 22 + 1)).toBeNull();
  });
});
