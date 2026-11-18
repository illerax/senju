import { describe, expect, it } from 'vitest';
import { paneIds, removePane, setSplitSizes, splitPane, terminalIds } from '../src/shared/layout';
import type { LayoutNode, PaneNode } from '../src/shared/types';

let n = 0;
const id = () => `s${++n}`;
const pane = (paneId: string, tabs = [`${paneId}1`]): PaneNode => ({ type: 'pane', id: paneId, tabs, activeTab: tabs[0] });

describe('splitPane', () => {
  it('wraps a single pane into a split', () => {
    const root = splitPane(pane('a'), 'a', pane('b'), 'right', id);
    expect(root).toMatchObject({ type: 'split', direction: 'row', sizes: [0.5, 0.5] });
    expect(paneIds(root)).toEqual(['a', 'b']);
  });

  it('inserts before the pane for left and up', () => {
    expect(paneIds(splitPane(pane('a'), 'a', pane('b'), 'left', id))).toEqual(['b', 'a']);
    expect(splitPane(pane('a'), 'a', pane('b'), 'up', id)).toMatchObject({ direction: 'column' });
  });

  it('adds to a split with the same direction by halving the target', () => {
    let root: LayoutNode = splitPane(pane('a'), 'a', pane('b'), 'right', id);
    root = splitPane(root, 'b', pane('c'), 'right', id);
    expect(root).toMatchObject({ type: 'split', sizes: [0.5, 0.25, 0.25] });
    expect(paneIds(root)).toEqual(['a', 'b', 'c']);
  });

  it('nests a split with the other direction', () => {
    let root: LayoutNode = splitPane(pane('a'), 'a', pane('b'), 'right', id);
    root = splitPane(root, 'b', pane('c'), 'down', id);
    expect(root.type === 'split' && root.children[1]).toMatchObject({ type: 'split', direction: 'column' });
  });
});

describe('removePane', () => {
  it('returns null for the last pane', () => {
    expect(removePane(pane('a'), 'a')).toBeNull();
  });

  it('collapses a split with one child left', () => {
    const root = splitPane(pane('a'), 'a', pane('b'), 'right', id);
    expect(removePane(root, 'b')).toEqual(pane('a'));
  });

  it('gives the freed space to the remaining panes', () => {
    let root: LayoutNode = splitPane(pane('a'), 'a', pane('b'), 'right', id);
    root = splitPane(root, 'b', pane('c'), 'right', id);
    expect(removePane(root, 'c')).toMatchObject({ sizes: [2 / 3, 1 / 3] });
  });

  it('merges a nested split of the same direction into its parent', () => {
    let root: LayoutNode = splitPane(pane('a'), 'a', pane('b'), 'right', id);
    root = splitPane(root, 'b', pane('c'), 'down', id);
    root = splitPane(root, 'c', pane('d'), 'right', id);
    const next = removePane(root, 'b')!;
    expect(next.type === 'split' && next.direction).toBe('row');
    expect(paneIds(next)).toEqual(['a', 'c', 'd']);
    expect(next.type === 'split' && next.sizes.reduce((x, y) => x + y)).toBeCloseTo(1);
  });
});

describe('layout helpers', () => {
  it('lists terminals of all tabs', () => {
    const root = splitPane(pane('a', ['t1', 't2']), 'a', pane('b', ['t3']), 'right', id);
    expect(terminalIds(root)).toEqual(['t1', 't2', 't3']);
  });

  it('normalizes split sizes and ignores invalid input', () => {
    const root = splitPane(pane('a'), 'a', pane('b'), 'right', () => 'x');
    expect(setSplitSizes(root, 'x', [3, 1])).toMatchObject({ sizes: [0.75, 0.25] });
    expect(setSplitSizes(root, 'x', [1])).toBe(root);
  });
});
