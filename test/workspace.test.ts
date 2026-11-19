import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyAction, closeTerminal, findPane } from '../src/daemon/workspace';
import { loadState } from '../src/daemon/store';
import { findPaneNode, panes, terminalIds } from '../src/shared/layout';
import { emptyState, type AppState } from '../src/shared/types';

function setup() {
  const state = emptyState();
  const { created } = applyAction(state, { type: 'createGroup', name: 'g', cwd: '/tmp' }, '/home/u');
  const group = state.groups[0];
  const workspace = group.workspaces[0];
  return { state, group, workspace, paneId: workspace.focusedPaneId, first: created[0] };
}

const paneOf = (state: AppState, paneId: string) => findPane(state, paneId)!.pane;

describe('groups and workspaces', () => {
  it('creates a group with one workspace, pane and tab', () => {
    const { state, workspace, first } = setup();
    expect(state.activeWorkspaceId).toBe(workspace.id);
    expect(terminalIds(workspace.root)).toEqual([first]);
    expect(state.terminals[first].cwd).toBe('/tmp');
  });

  it('adds workspaces after the active one and names them', () => {
    const { state, group } = setup();
    applyAction(state, { type: 'createWorkspace', groupId: group.id }, '/');
    expect(group.workspaces.map((w) => w.name)).toEqual(['Workspace 1', 'Workspace 2']);
    expect(state.activeWorkspaceId).toBe(group.workspaces[1].id);
  });

  it('moves a workspace to another group', () => {
    const { state, group, workspace } = setup();
    applyAction(state, { type: 'createGroup', name: 'h', cwd: '/' }, '/');
    const other = state.groups[1];
    applyAction(state, { type: 'moveWorkspace', workspaceId: workspace.id, groupId: other.id, toIndex: 0 }, '/');
    expect(group.workspaces).toHaveLength(0);
    expect(other.workspaces.map((w) => w.id)[0]).toBe(workspace.id);
  });

  it('reorders groups', () => {
    const { state } = setup();
    applyAction(state, { type: 'createGroup', name: 'h', cwd: '/' }, '/');
    applyAction(state, { type: 'moveGroup', groupId: state.groups[1].id, toIndex: 0 }, '/');
    expect(state.groups.map((g) => g.name)).toEqual(['h', 'g']);
  });

  it('deletes a group with all its terminals and picks another workspace', () => {
    const { state, group } = setup();
    applyAction(state, { type: 'createGroup', name: 'h', cwd: '/' }, '/');
    const other = state.groups[1];
    applyAction(state, { type: 'activateWorkspace', workspaceId: group.workspaces[0].id }, '/');
    applyAction(state, { type: 'deleteGroup', groupId: group.id }, '/');
    expect(state.groups).toEqual([other]);
    expect(Object.keys(state.terminals)).toEqual(terminalIds(other.workspaces[0].root));
    expect(state.activeWorkspaceId).toBe(other.workspaces[0].id);
  });
});

describe('panes and tabs', () => {
  it('splits a pane in the directory of its active tab and focuses the new pane', () => {
    const { state, workspace, paneId, first } = setup();
    state.terminals[first].cwd = '/tmp/sub';
    const { created } = applyAction(state, { type: 'splitPane', paneId, side: 'down' }, '/');
    expect(panes(workspace.root)).toHaveLength(2);
    expect(paneOf(state, workspace.focusedPaneId).tabs).toEqual(created);
    expect(state.terminals[created[0]].cwd).toBe('/tmp/sub');
  });

  it('adds tabs after the active one', () => {
    const { state, paneId, first } = setup();
    const { created: [second] } = applyAction(state, { type: 'createTab', paneId }, '/');
    applyAction(state, { type: 'activateTab', terminalId: first }, '/');
    const { created: [third] } = applyAction(state, { type: 'createTab', paneId }, '/');
    expect(paneOf(state, paneId).tabs).toEqual([first, third, second]);
    expect(paneOf(state, paneId).activeTab).toBe(third);
  });

  it('closing a tab activates its neighbor; the last tab closes the pane', () => {
    const { state, workspace, paneId, first } = setup();
    const { created: [second] } = applyAction(state, { type: 'createTab', paneId }, '/');
    applyAction(state, { type: 'splitPane', paneId, side: 'right' }, '/');
    applyAction(state, { type: 'closeTab', terminalId: second }, '/');
    expect(paneOf(state, paneId)).toMatchObject({ tabs: [first], activeTab: first });
    applyAction(state, { type: 'closeTab', terminalId: first }, '/');
    expect(findPaneNode(workspace.root, paneId)).toBeNull();
    expect(panes(workspace.root)).toHaveLength(1);
  });

  it('closing the last terminal closes the workspace', () => {
    const { state, group, first } = setup();
    const effects = { created: [], removed: [] as string[] };
    closeTerminal(state, first, effects);
    expect(effects.removed).toEqual([first]);
    expect(group.workspaces).toHaveLength(0);
    expect(state.activeWorkspaceId).toBeNull();
  });

  it('closing a pane closes all its tabs', () => {
    const { state, paneId } = setup();
    applyAction(state, { type: 'createTab', paneId }, '/');
    applyAction(state, { type: 'splitPane', paneId, side: 'right' }, '/');
    const tabs = paneOf(state, paneId).tabs;
    const { removed } = applyAction(state, { type: 'closePane', paneId }, '/');
    expect(removed.sort()).toEqual([...tabs].sort());
  });

  it('moves a tab to another pane, closing the emptied pane but keeping the terminal', () => {
    const { state, workspace, paneId, first } = setup();
    applyAction(state, { type: 'splitPane', paneId, side: 'right' }, '/');
    const target = workspace.focusedPaneId;
    const { removed } = applyAction(state, { type: 'moveTab', terminalId: first, paneId: target, toIndex: 0 }, '/');
    expect(removed).toEqual([]);
    expect(state.terminals[first]).toBeDefined();
    expect(panes(workspace.root)).toHaveLength(1);
    expect(paneOf(state, target)).toMatchObject({ activeTab: first });
    expect(paneOf(state, target).tabs[0]).toBe(first);
  });

  it('reorders tabs within a pane', () => {
    const { state, paneId, first } = setup();
    const { created: [second] } = applyAction(state, { type: 'createTab', paneId }, '/');
    applyAction(state, { type: 'moveTab', terminalId: first, paneId, toIndex: 2 }, '/');
    expect(paneOf(state, paneId).tabs).toEqual([second, first]);
  });
});

describe('loadState', () => {
  it('migrates projects with windows into groups with workspaces', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'senju-'));
    const file = path.join(dir, 'state.json');
    const v1 = {
      version: 1,
      activeProjectId: 'p',
      projects: [
        {
          id: 'p',
          name: 'proj',
          cwd: '/w',
          activeWindowId: 'w',
          windows: [
            {
              id: 'w',
              name: 'Window 1',
              focusedPaneId: 'b',
              root: { type: 'split', id: 's', direction: 'row', sizes: [0.5, 0.5], children: [{ type: 'pane', paneId: 'a' }, { type: 'pane', paneId: 'b' }] },
            },
          ],
        },
      ],
      panes: { a: { id: 'a', cwd: '/w', cols: 80, rows: 24, env: {} }, b: { id: 'b', cwd: '/w', cols: 80, rows: 24, env: {} } },
      ui: {},
    };
    fs.writeFileSync(file, JSON.stringify(v1));
    const state = loadState(file);
    fs.rmSync(dir, { recursive: true });
    expect(state.version).toBe(2);
    expect(state.activeWorkspaceId).toBe('w');
    const workspace = state.groups[0].workspaces[0];
    expect(terminalIds(workspace.root)).toEqual(['a', 'b']);
    expect(findPaneNode(workspace.root, workspace.focusedPaneId)?.tabs).toEqual(['b']);
    expect(Object.keys(state.terminals)).toEqual(['a', 'b']);
  });
});

describe('group names', () => {
  it('names groups without a name Group N', () => {
    const state = emptyState();
    applyAction(state, { type: 'createGroup', name: '', cwd: '/home/u' }, '/home/u');
    applyAction(state, { type: 'createGroup', name: '', cwd: '/home/u' }, '/home/u');
    expect(state.groups.map((g) => g.name)).toEqual(['Group 1', 'Group 2']);
    expect(state.groups[0].cwd).toBe('/home/u');
  });
});

describe('group default path', () => {
  it('opens new workspaces in the group path, not the current terminal directory', () => {
    const { state, group, first } = setup();
    state.terminals[first].cwd = '/tmp/elsewhere';
    applyAction(state, { type: 'setGroupCwd', groupId: group.id, cwd: '/srv/app' }, '/');
    const { created } = applyAction(state, { type: 'createWorkspace', groupId: group.id }, '/');
    expect(group.cwd).toBe('/srv/app');
    expect(state.terminals[created[0]].cwd).toBe('/srv/app');
  });
});

describe('workspace color', () => {
  it('sets and clears a color, ignoring invalid values', () => {
    const { state, workspace } = setup();
    applyAction(state, { type: 'setWorkspaceColor', workspaceId: workspace.id, color: '#e06c75' }, '/');
    expect(workspace.color).toBe('#e06c75');
    applyAction(state, { type: 'setWorkspaceColor', workspaceId: workspace.id, color: 'red; background: x' }, '/');
    expect(workspace.color).toBeUndefined();
    applyAction(state, { type: 'setWorkspaceColor', workspaceId: workspace.id, color: '#61afef' }, '/');
    applyAction(state, { type: 'setWorkspaceColor', workspaceId: workspace.id, color: null }, '/');
    expect(workspace.color).toBeUndefined();
  });
});

describe('tab zoom', () => {
  it('stores a zoom per terminal and drops it when reset', () => {
    const { state, first } = setup();
    applyAction(state, { type: 'zoomTab', terminalId: first, zoom: 3 }, '/');
    expect(state.terminals[first].zoom).toBe(3);
    applyAction(state, { type: 'zoomTab', terminalId: first, zoom: 0 }, '/');
    expect(state.terminals[first].zoom).toBeUndefined();
    applyAction(state, { type: 'zoomTab', terminalId: first, zoom: Number.NaN }, '/');
    expect(state.terminals[first].zoom).toBeUndefined();
  });
});

describe('scrollback files', () => {
  it('moves inline scrollback of old state files into separate files', async () => {
    const { readScrollback } = await import('../src/daemon/store');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'senju-'));
    const file = path.join(dir, 'state.json');
    const state = { ...emptyState(), terminals: { t1: { id: 't1', cwd: '/', cols: 80, rows: 24, env: {}, scrollback: 'old output' } } };
    fs.writeFileSync(file, JSON.stringify(state));
    const loaded = loadState(file);
    expect('scrollback' in loaded.terminals.t1).toBe(false);
    expect(readScrollback(file, 't1')).toBe('old output');
    fs.rmSync(dir, { recursive: true });
  });
});
