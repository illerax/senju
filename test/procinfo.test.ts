import { describe, expect, it } from 'vitest';
import { parseLsofCwd, parsePs } from '../src/daemon/procinfo';

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
});
