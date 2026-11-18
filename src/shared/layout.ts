// Pure operations on the pane layout tree. Functions return a new root and
// never mutate their input.

import type { LayoutNode, PaneNode, SplitDirection, SplitNode } from './types';
import type { SplitSide } from './protocol';

export function panes(node: LayoutNode): PaneNode[] {
  return node.type === 'pane' ? [node] : node.children.flatMap(panes);
}

export function paneIds(node: LayoutNode): string[] {
  return panes(node).map((p) => p.id);
}

export function terminalIds(node: LayoutNode): string[] {
  return panes(node).flatMap((p) => p.tabs);
}

export function findPaneNode(node: LayoutNode, paneId: string): PaneNode | null {
  return panes(node).find((p) => p.id === paneId) ?? null;
}

/** The pane holding a terminal as one of its tabs. */
export function paneOfTerminal(node: LayoutNode, terminalId: string): PaneNode | null {
  return panes(node).find((p) => p.tabs.includes(terminalId)) ?? null;
}

/** Replaces the pane with the given id by the result of `update`. */
export function updatePane(root: LayoutNode, paneId: string, update: (pane: PaneNode) => PaneNode): LayoutNode {
  if (root.type === 'pane') return root.id === paneId ? update(root) : root;
  return { ...root, children: root.children.map((c) => updatePane(c, paneId, update)) };
}

function normalizeSizes(sizes: number[]): number[] {
  const total = sizes.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return sizes.map(() => 1 / sizes.length);
  return sizes.map((s) => s / total);
}

/** Inserts `newPane` next to the pane `paneId` on the given side. */
export function splitPane(root: LayoutNode, paneId: string, newPane: PaneNode, side: SplitSide, newSplitId: () => string): LayoutNode {
  const direction: SplitDirection = side === 'left' || side === 'right' ? 'row' : 'column';
  const before = side === 'left' || side === 'up';

  const visit = (node: LayoutNode): LayoutNode => {
    if (node.type === 'pane') {
      if (node.id !== paneId) return node;
      return {
        type: 'split',
        id: newSplitId(),
        direction,
        children: before ? [newPane, node] : [node, newPane],
        sizes: [0.5, 0.5],
      };
    }
    const index = node.children.findIndex((c) => c.type === 'pane' && c.id === paneId);
    if (index >= 0 && node.direction === direction) {
      // Same direction: split the target's share in half instead of nesting.
      const children = [...node.children];
      const sizes = [...node.sizes];
      const half = sizes[index] / 2;
      const at = before ? index : index + 1;
      sizes[index] = half;
      children.splice(at, 0, newPane);
      sizes.splice(at, 0, half);
      return { ...node, children, sizes };
    }
    return { ...node, children: node.children.map(visit) };
  };

  return visit(root);
}

/** Removes a pane; its space goes to the neighbors. Returns null when the tree becomes empty. */
export function removePane(root: LayoutNode, paneId: string): LayoutNode | null {
  const visit = (node: LayoutNode): LayoutNode | null => {
    if (node.type === 'pane') return node.id === paneId ? null : node;
    const children: LayoutNode[] = [];
    const sizes: number[] = [];
    node.children.forEach((child, i) => {
      const next = visit(child);
      if (next) {
        children.push(next);
        sizes.push(node.sizes[i]);
      }
    });
    if (children.length === 0) return null;
    if (children.length === 1) return children[0];
    // Collapse a child split with the same direction into this one.
    const flatChildren: LayoutNode[] = [];
    const flatSizes: number[] = [];
    children.forEach((child, i) => {
      if (child.type === 'split' && child.direction === node.direction) {
        child.children.forEach((c, j) => {
          flatChildren.push(c);
          flatSizes.push(sizes[i] * child.sizes[j]);
        });
      } else {
        flatChildren.push(child);
        flatSizes.push(sizes[i]);
      }
    });
    return { ...node, children: flatChildren, sizes: normalizeSizes(flatSizes) };
  };
  return visit(root);
}

export function setSplitSizes(root: LayoutNode, splitId: string, sizes: number[]): LayoutNode {
  const visit = (node: LayoutNode): LayoutNode => {
    if (node.type === 'pane') return node;
    if (node.id === splitId) {
      if (sizes.length !== node.children.length || sizes.some((s) => !(s > 0))) return node;
      return { ...node, sizes: normalizeSizes(sizes) };
    }
    return { ...node, children: node.children.map(visit) };
  };
  return visit(root);
}

export function findSplit(root: LayoutNode, splitId: string): SplitNode | null {
  if (root.type === 'pane') return null;
  if (root.id === splitId) return root;
  for (const child of root.children) {
    const found = findSplit(child, splitId);
    if (found) return found;
  }
  return null;
}
