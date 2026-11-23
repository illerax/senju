import { describe, expect, it } from 'vitest';
import { insertRestored, restoreGroup, snapshotGroup } from '../src/daemon/closed-groups';
import { applyAction } from '../src/daemon/workspace';
import { panes, terminalIds } from '../src/shared/layout';
import { emptyState, type AppState } from '../src/shared/types';

const W = 'win';

/** An empty state with one window. */
function newState(): AppState {
  return { ...emptyState(), windows: [{ id: W, activeWorkspaceId: null, ui: {} }] };
}

const active = (state: AppState, windowId = W) => state.windows.find((w) => w.id === windowId)?.activeWorkspaceId ?? null;

function twoGroups() {
  const state = newState();
  applyAction(state, { type: 'createGroup', windowId: W, name: 'first', cwd: '/a' }, '/');
  applyAction(state, { type: 'createGroup', windowId: W, name: 'second', cwd: '/b' }, '/');
  const group = state.groups[1];
  applyAction(state, { type: 'splitPane', paneId: group.workspaces[0].focusedPaneId, side: 'right' }, '/');
  applyAction(state, { type: 'createWorkspace', groupId: group.id }, '/');
  const [id] = terminalIds(group.workspaces[0].root);
  state.terminals[id].job = { argv: ['claude'], cwd: '/b', env: {}, startedAt: 1, recipe: 'claude-code', sessionId: 's1' };
  state.terminals[id].agent = { state: 'working', at: 1 };
  return { state, group, id };
}

describe('closed groups', () => {
  it('saves a group with its terminals, place and active workspace', () => {
    const { state, group, id } = twoGroups();
    const saved = snapshotGroup(state, group.id, { [id]: 'output' }, 42)!;
    expect(saved).toMatchObject({ format: 'senju-group', version: 1, savedAt: 42, index: 1, activeWorkspaceId: group.workspaces[1].id });
    expect(Object.keys(saved.terminals)).toHaveLength(3);
    expect(saved.terminals[id].job?.sessionId).toBe('s1');
    expect(saved.terminals[id].agent).toBeUndefined();
    expect(saved.scrollback).toEqual({ [id]: 'output' });
    expect(snapshotGroup(state, 'missing', {}, 0)).toBeNull();
  });

  it('opens it again at its place with fresh ids, next to the original', () => {
    const { state, group, id } = twoGroups();
    const saved = snapshotGroup(state, group.id, { [id]: 'output' }, 42)!;
    applyAction(state, { type: 'deleteGroup', groupId: group.id }, '/');
    applyAction(state, { type: 'createGroup', windowId: W, name: 'third', cwd: '/c' }, '/');
    const restored = restoreGroup(saved);
    insertRestored(state, restored, saved.index, W);
    expect(state.groups.map((g) => g.name)).toEqual(['first', 'second', 'third']);
    const back = state.groups[1];
    expect(back.id).not.toBe(group.id);
    expect(back.workspaces.map((w) => w.name)).toEqual(group.workspaces.map((w) => w.name));
    expect(panes(back.workspaces[0].root)).toHaveLength(2);
    expect(active(state)).toBe(back.workspaces[1].id);
    const ids = back.workspaces.flatMap((w) => terminalIds(w.root));
    expect(ids.every((i) => state.terminals[i]?.id === i && !Object.keys(saved.terminals).includes(i))).toBe(true);
    expect(state.terminals[ids[0]].job?.sessionId).toBe('s1');
    expect(restored.scrollback[ids[0]]).toBe('output');
    for (const w of back.workspaces) expect(panes(w.root).some((p) => p.id === w.focusedPaneId)).toBe(true);
    // A second copy gets other ids again.
    const copy = restoreGroup(saved);
    expect(Object.keys(copy.terminals).some((i) => ids.includes(i))).toBe(false);
  });
});
