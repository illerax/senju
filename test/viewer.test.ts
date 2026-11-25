import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { insertRestored, restoreGroup, snapshotGroup } from '../src/daemon/closed-groups';
import { ownedFileName } from '../src/daemon/viewers';
import { applyAction, findTab, showViewer, shownBefore, splitSide } from '../src/daemon/workspace';
import { handleMcp } from '../src/cli/mcp';
import { commandEnv } from '../src/daemon/senju-command';
import { panes, tabIds } from '../src/shared/layout';
import { emptyState, type AppState, type ViewerState } from '../src/shared/types';
import { extensionFor, viewerFormat, viewerLabel } from '../src/shared/viewer';
import { parseCsv, parseJson, parseYaml } from '../src/renderer/viewer-parse';

const W = 'win';

function setup() {
  const state: AppState = { ...emptyState(), windows: [{ id: W, activeWorkspaceId: null, ui: {} }] };
  const { created } = applyAction(state, { type: 'createGroup', windowId: W, name: 'g', cwd: '/tmp' }, '/home/u');
  const workspace = state.groups[0].workspaces[0];
  return { state, workspace, terminal: created[0], paneId: workspace.focusedPaneId };
}

const viewer = (id: string, file: string, extra: Partial<ViewerState> = {}): ViewerState => ({ id, file, ...extra });

/** Shows a viewer as the daemon does, updating the one shown before if it is open. */
const show = (state: AppState, terminal: string, asked: ViewerState, id?: string) => showViewer(state, terminal, asked, shownBefore(state, terminal, asked, id));

describe('viewer formats', () => {
  it('tells the format by the extension', () => {
    expect(viewerFormat('/r/report.md').kind).toBe('markdown');
    expect(viewerFormat('/r/data.JSON').kind).toBe('json');
    expect(viewerFormat('/r/ci.yml').kind).toBe('yaml');
    expect(viewerFormat('/r/t.tsv')).toEqual({ kind: 'csv', separator: '\t' });
    expect(viewerFormat('/r/shot.png').kind).toBe('image');
    expect(viewerFormat('/r/main.rs')).toEqual({ kind: 'code', language: 'rust' });
    expect(viewerFormat('/r/Dockerfile')).toEqual({ kind: 'code', language: 'dockerfile' });
    expect(viewerFormat('/r/notes')).toEqual({ kind: 'text' });
  });

  it('takes the format asked for, by name, language or extension', () => {
    expect(viewerFormat('/r/out.txt', 'markdown').kind).toBe('markdown');
    expect(viewerFormat('/r/out.txt', 'python')).toEqual({ kind: 'code', language: 'python' });
    expect(viewerFormat('/r/out.txt', 'py')).toEqual({ kind: 'code', language: 'python' });
    expect(viewerFormat('/r/page.html', 'nonsense').kind).toBe('html');
    expect(viewerFormat('/r/x.ts', 'code')).toEqual({ kind: 'code', language: 'typescript' });
  });

  it('names files of content by its format', () => {
    expect(extensionFor('markdown')).toBe('markdown');
    expect(extensionFor('python')).toBe('py');
    expect(extensionFor(undefined)).toBe('txt');
    expect(ownedFileName('Test report', 'markdown')).toBe('Test report.markdown');
    expect(ownedFileName('report.md', undefined)).toBe('report.md');
    expect(ownedFileName('a/b:c', 'json')).toBe('abc.json');
    expect(ownedFileName(undefined, undefined)).toBe('content.txt');
    expect(viewerLabel({ file: '/x/y/report.md' })).toBe('report.md');
  });
});

describe('parsing', () => {
  it('reads JSON with comments and trailing commas', () => {
    expect(parseJson('{"a": [1, 2]}')).toEqual({ a: [1, 2] });
    expect(parseJson('{\n  // note\n  "url": "http://x//y", /* c */ "b": [1,],\n}')).toEqual({ url: 'http://x//y', b: [1] });
    expect(() => parseJson('{"a": }')).toThrow();
  });

  it('reads YAML, several documents as a list', () => {
    expect(parseYaml('a: 1\nb: [x, y]\n')).toEqual({ a: 1, b: ['x', 'y'] });
    expect(parseYaml('a: 1\n---\nb: 2\n')).toEqual([{ a: 1 }, { b: 2 }]);
    expect(() => parseYaml('a: [1\n')).toThrow();
  });

  it('reads CSV with quoted fields', () => {
    expect(parseCsv('a,b\n1,"x, ""y"""\r\n2,\n', ',')).toEqual([['a', 'b'], ['1', 'x, "y"'], ['2', '']]);
    expect(parseCsv('a\tb\n1\t2', '\t')).toEqual([['a', 'b'], ['1', '2']]);
  });
});

describe('showing viewers', () => {
  it('opens a viewer in a new pane beside the terminal and keeps the focus', () => {
    const { state, workspace, terminal, paneId } = setup();
    expect(show(state, terminal, viewer('v1', '/r/a.md'))).toBe('v1');
    const all = panes(workspace.root);
    expect(workspace.root.type === 'split' && workspace.root.direction).toBe('row');
    expect(all[1].tabs).toEqual(['v1']);
    expect(workspace.focusedPaneId).toBe(paneId);
  });

  it('adds more viewers to the viewer pane and brings an open file to the front', () => {
    const { state, workspace, terminal } = setup();
    show(state, terminal, viewer('v1', '/r/a.md'));
    show(state, terminal, viewer('v2', '/r/b.json'));
    expect(show(state, terminal, viewer('v3', '/r/a.md', { name: 'A' }))).toBe('v1');
    const pane = panes(workspace.root)[1];
    expect(pane.tabs).toEqual(['v1', 'v2']);
    expect(pane.activeTab).toBe('v1');
    expect(state.viewers.v1.name).toBe('A');
    expect(state.viewers.v3).toBeUndefined();
    // Content sent without a file and without a name is always new.
    show(state, terminal, viewer('v4', '/s/viewers/v4/x.md', { owned: true }));
    expect(panes(workspace.root)[1].tabs).toEqual(['v1', 'v4', 'v2']);
  });

  it('updates content sent again under its name, or by its id, wherever it is', () => {
    const { state, workspace, terminal } = setup();
    show(state, terminal, viewer('v1', '/s/viewers/v1/plan.md', { owned: true, name: 'Plan' }));
    show(state, terminal, viewer('v2', '/r/b.md'));
    expect(state.viewers.v1.source).toBe(terminal);
    applyAction(state, { type: 'popOutViewer', viewerId: 'v1' }, '/');
    expect(show(state, terminal, viewer('v3', '', { owned: true, name: 'Plan' }))).toBe('v1');
    expect(state.viewers.v1).toMatchObject({ window: true, file: '/s/viewers/v1/plan.md' });
    expect(state.viewers.v3).toBeUndefined();
    // Another name, or another terminal's agent, gets a tab of its own.
    expect(show(state, terminal, viewer('v4', '', { owned: true, name: 'Notes' }))).toBe('v4');
    expect(shownBefore(state, 'other', viewer('v5', '', { owned: true, name: 'Plan' }))).toBeUndefined();
    expect(show(state, terminal, viewer('v6', '', { owned: true }), 'v4')).toBe('v4');
    // An id of a file viewer is not one for content.
    expect(shownBefore(state, terminal, viewer('v7', '', { owned: true }), 'v2')).toBeUndefined();
    expect(tabIds(workspace.root)).toEqual([terminal, 'v2', 'v4']);
  });

  it('finds a file moved to another window and leaves it there', () => {
    const { state, workspace, terminal } = setup();
    show(state, terminal, viewer('v1', '/r/a.md'));
    show(state, terminal, viewer('v2', '/r/b.md'));
    applyAction(state, { type: 'createWindow', windowId: 'w2', tabId: 'v1' }, '/');
    expect(show(state, terminal, viewer('v3', '/r/a.md'))).toBe('v1');
    expect(tabIds(workspace.root)).toEqual([terminal, 'v2']);
    expect(findTab(state, 'v1')?.group.windowId).toBe('w2');
  });

  it('splits below a tall terminal', () => {
    expect(splitSide({ id: 't', cwd: '/', cols: 160, rows: 40, env: {} })).toBe('right');
    expect(splitSide({ id: 't', cwd: '/', cols: 60, rows: 50, env: {} })).toBe('down');
  });

  it('opens a viewer in a window of its own, out of the layout', () => {
    const { state, workspace, terminal } = setup();
    show(state, terminal, viewer('v1', '/r/a.md', { window: true }));
    expect(tabIds(workspace.root)).toEqual([terminal]);
    expect(state.viewers.v1.window).toBe(true);
    expect(show(state, 'missing', viewer('v2', '/r/b.md'))).toBeNull();
  });

  it('closes, renames, zooms and pops out viewers like tabs', () => {
    const { state, workspace, terminal } = setup();
    show(state, terminal, viewer('v1', '/r/a.md'));
    show(state, terminal, viewer('v2', '/r/b.md'));
    applyAction(state, { type: 'renameTab', terminalId: 'v1', name: 'Report' }, '/');
    applyAction(state, { type: 'zoomTab', terminalId: 'v1', zoom: 2 }, '/');
    expect(state.viewers.v1).toMatchObject({ name: 'Report', zoom: 2 });
    applyAction(state, { type: 'popOutViewer', viewerId: 'v2' }, '/');
    expect(state.viewers.v2.window).toBe(true);
    expect(tabIds(workspace.root)).toEqual([terminal, 'v1']);
    expect(applyAction(state, { type: 'closeViewer', viewerId: 'v2' }, '/').removed).toEqual(['v2']);
    expect(applyAction(state, { type: 'closeTab', terminalId: 'v1' }, '/').removed).toEqual(['v1']);
    expect(state.viewers).toEqual({});
    expect(workspace.root.type).toBe('pane');
  });

  it('returns a viewer from its window to the pane it came from, else next to its terminal', () => {
    const { state, workspace, terminal } = setup();
    show(state, terminal, viewer('v1', '/r/a.md'));
    show(state, terminal, viewer('v2', '/r/b.md'));
    const viewerPane = panes(workspace.root)[1].id;
    applyAction(state, { type: 'popOutViewer', viewerId: 'v1' }, '/');
    expect(state.viewers.v1.pane).toBe(viewerPane);
    applyAction(state, { type: 'dockViewer', viewerId: 'v1' }, '/');
    expect(state.viewers.v1).toEqual({ id: 'v1', file: '/r/a.md', source: terminal });
    expect(panes(workspace.root)[1]).toMatchObject({ id: viewerPane, tabs: ['v2', 'v1'], activeTab: 'v1' });
    expect(workspace.focusedPaneId).toBe(viewerPane);
    // Its pane closed with its last tab: it goes next to the terminal again.
    applyAction(state, { type: 'popOutViewer', viewerId: 'v1' }, '/');
    applyAction(state, { type: 'popOutViewer', viewerId: 'v2' }, '/');
    expect(workspace.root.type).toBe('pane');
    applyAction(state, { type: 'dockViewer', viewerId: 'v1' }, '/');
    expect(panes(workspace.root).map((p) => p.tabs)).toEqual([[terminal], ['v1']]);
    // Nothing of either left: the first window showing a workspace takes it.
    applyAction(state, { type: 'closeTab', terminalId: terminal }, '/');
    applyAction(state, { type: 'createGroup', windowId: W, name: 'h', cwd: '/tmp' }, '/');
    applyAction(state, { type: 'dockViewer', viewerId: 'v2' }, '/');
    expect(findTab(state, 'v2')?.group.name).toBe('h');
    expect(state.viewers.v2.window).toBeUndefined();
  });

  it('moves tabs and viewers of their own windows to other windows', () => {
    const { state, workspace, terminal } = setup();
    const { created } = applyAction(state, { type: 'createTab', paneId: workspace.focusedPaneId }, '/');
    show(state, terminal, viewer('v1', '/r/a.md', { window: true }));
    // A window showing no workspace gets a group like the tab's.
    applyAction(state, { type: 'createWindow', windowId: 'w2' }, '/');
    applyAction(state, { type: 'moveTabToWindow', terminalId: created[0], windowId: 'w2' }, '/');
    const [, moved] = state.groups;
    expect(moved).toMatchObject({ name: 'g', cwd: '/tmp', windowId: 'w2' });
    expect(tabIds(moved.workspaces[0].root)).toEqual([created[0]]);
    expect(state.windows[1].activeWorkspaceId).toBe(moved.workspaces[0].id);
    expect(tabIds(workspace.root)).toEqual([terminal]);
    // One showing a workspace gets it in its focused pane.
    applyAction(state, { type: 'moveTabToWindow', terminalId: 'v1', windowId: 'w2' }, '/');
    expect(moved.workspaces[0].root).toMatchObject({ tabs: [created[0], 'v1'], activeTab: 'v1' });
    expect(state.viewers.v1.window).toBeUndefined();
    // Moving to the window it is in does nothing; the last tab leaves its workspace.
    applyAction(state, { type: 'moveTabToWindow', terminalId: 'v1', windowId: 'w2' }, '/');
    applyAction(state, { type: 'moveTabToWindow', terminalId: terminal, windowId: 'w2' }, '/');
    expect(tabIds(moved.workspaces[0].root)).toEqual([created[0], 'v1', terminal]);
    expect(state.groups[0].workspaces).toEqual([]);
    expect(state.windows[0].activeWorkspaceId).toBeNull();
  });

  it('opens a file the user picked in the pane, focused', () => {
    const { state, workspace, paneId, terminal } = setup();
    applyAction(state, { type: 'openViewer', paneId, file: '/r/a.md' }, '/');
    const pane = panes(workspace.root)[0];
    expect(pane.tabs.length).toBe(2);
    expect(state.viewers[pane.activeTab].file).toBe('/r/a.md');
    // A new terminal next to a viewer starts in the folder of the pane's terminal.
    applyAction(state, { type: 'createTab', paneId }, '/');
    const created = panes(workspace.root)[0].activeTab;
    expect(state.terminals[created].cwd).toBe(state.terminals[terminal].cwd);
  });

  it('keeps viewers and the content Senju kept with a closed group', () => {
    const { state, terminal } = setup();
    show(state, terminal, viewer('v1', '/r/a.md'));
    show(state, terminal, viewer('v2', '/s/viewers/v2/x.md', { owned: true }));
    const saved = snapshotGroup(state, state.groups[0].id, {}, 1, { v2: '# kept' })!;
    expect(Object.keys(saved.viewers!)).toEqual(['v1', 'v2']);
    expect(saved.terminals.v1).toBeUndefined();
    const restored = restoreGroup(saved);
    const ids = Object.keys(restored.viewers);
    expect(ids).toHaveLength(2);
    expect(ids).not.toContain('v1');
    expect(Object.values(restored.viewerContent)).toEqual(['# kept']);
    const fresh: AppState = { ...emptyState(), windows: [{ id: W, activeWorkspaceId: null, ui: {} }] };
    insertRestored(fresh, restored, 0, W);
    expect(Object.keys(fresh.viewers)).toEqual(ids);
    expect(Object.keys(fresh.terminals)).toHaveLength(1);
  });
});

describe('the senju command', () => {
  it('comes first in PATH once', () => {
    const list = (...dirs: string[]) => dirs.join(path.delimiter);
    const env = commandEnv('/run/senju/bin', '/run/senju/daemon.sock', { PATH: list('/usr/bin', '/run/senju/bin', '/bin') });
    expect(env).toEqual({ PATH: list('/run/senju/bin', '/usr/bin', '/bin'), SENJU_SOCKET: '/run/senju/daemon.sock' });
  });

  it('serves the MCP tools', async () => {
    const shown: unknown[] = [];
    const show = async (request: unknown) => {
      shown.push(request);
      return { viewerId: 'v1' };
    };
    const init = (await handleMcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, show, '1')) as { result: { protocolVersion: string } };
    expect(init.result.protocolVersion).toBe('2025-03-26');
    expect(await handleMcp({ jsonrpc: '2.0', method: 'notifications/initialized' }, show, '1')).toBeNull();
    const call = (await handleMcp({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'show_file', arguments: { path: 'a.md', window: true } } }, show, '1')) as {
      result: { isError?: boolean };
    };
    expect(call.result).toEqual({ content: [{ type: 'text', text: 'a.md is shown in a Senju tab, id v1.' }] });
    expect(shown).toEqual([{ file: 'a.md', format: undefined, name: undefined, window: true, id: undefined }]);
    const failed = (await handleMcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'show_content', arguments: { content: 'x' } } }, async () => {
      throw new Error('Run senju in a terminal of Senju.');
    }, '1')) as { result: { isError: boolean; content: { text: string }[] } };
    expect(failed.result).toMatchObject({ isError: true, content: [{ text: 'Run senju in a terminal of Senju.' }] });
    expect(await handleMcp({ jsonrpc: '2.0', id: 4, method: 'resources/list' }, show, '1')).toMatchObject({ error: { code: -32601 } });
  });
});
