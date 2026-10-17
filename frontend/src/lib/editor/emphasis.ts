import type { Extension, Text } from '@codemirror/state';
import { keymap, type Command, type EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode, SyntaxNodeRef, Tree } from '@lezer/common';

// ──────────────────────────────────────────────────────────────────────────────
// 公开类型
// ──────────────────────────────────────────────────────────────────────────────

/** 强调种类：粗体 / 斜体 */
export type EmphasisKind = 'bold' | 'italic';

export interface EmphasisOptions {
  /**
   * 是否自动绑定 `Mod-b` / `Mod-i` 快捷键。
   * 关闭后可自行通过 `toggleBold` / `toggleItalic` 命令绑定到其他键位。
   * @default true
   */
  bindKeymap?: boolean;
}

// ──────────────────────────────────────────────────────────────────────────────
// Lezer markdown 节点常量
// ──────────────────────────────────────────────────────────────────────────────

const NODE_BOLD = 'StrongEmphasis';
const NODE_ITALIC = 'Emphasis';
const NODE_MARK = 'EmphasisMark';

/**
 * `***bold***` 全选时，内层目标节点与外层 EmphasisMark 之间的最大允许间隙。
 * 长度 1 的 `EmphasisMark` × 两端 = 2，留 0 容错。
 */
const MAX_ENCLOSE_GAP = 2;

// ──────────────────────────────────────────────────────────────────────────────
// 基础工具
// ──────────────────────────────────────────────────────────────────────────────

function isEmphasisNode(node: SyntaxNode, kind: EmphasisKind): boolean {
  return node.name === (kind === 'bold' ? NODE_BOLD : NODE_ITALIC);
}

function markerFor(kind: EmphasisKind): string {
  return kind === 'bold' ? '**' : '*';
}

function pairAt(doc: Text, pos: number, marker: string): boolean {
  const len = marker.length;
  const before = doc.sliceString(Math.max(0, pos - len), pos);
  const after = doc.sliceString(pos, Math.min(doc.length, pos + len));
  return before === marker && after === marker;
}

// ──────────────────────────────────────────────────────────────────────────────
// AST 查找
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 从 from 位置的最内层节点起向上找"完全覆盖 [from,to] 的最内层"目标节点。
 * 这是"选区/光标 ⊆ 节点"的方向。
 */
function findContainingEmphasis(
  tree: Tree,
  from: number,
  to: number,
  kind: EmphasisKind
): SyntaxNode | null {
  let node: SyntaxNode | null = tree.resolveInner(from, 1);
  while (node) {
    if (isEmphasisNode(node, kind) && node.from <= from && node.to >= to) {
      return node;
    }
    node = node.parent;
  }
  return null;
}

/**
 * 反向查找："节点 ⊆ 选区"。用于 `***bold***` 全选的场景——外层 Emphasis
 * 覆盖整个选区，内层 StrongEmphasis 被选区包围，此时只能通过反向包含识别。
 *
 * 约束：
 *  - 选区内必须恰好只有一个目标节点（避免多目标歧义）
 *  - 节点与外层标记边界间隔 ≤ MAX_ENCLOSE_GAP
 */
function findEnclosedEmphasis(
  tree: Tree,
  from: number,
  to: number,
  kind: EmphasisKind
): SyntaxNode | null {
  const candidates: SyntaxNode[] = [];
  tree.iterate({
    from,
    to,
    enter: (ref: SyntaxNodeRef) => {
      if (ref.from >= from && ref.to <= to && isEmphasisNode(ref.node, kind)) {
        candidates.push(ref.node);
      }
    }
  });
  if (candidates.length !== 1) return null;
  const node = candidates[0]!;
  if (node.from - from > MAX_ENCLOSE_GAP) return null;
  if (to - node.to > MAX_ENCLOSE_GAP) return null;
  return node;
}

// ──────────────────────────────────────────────────────────────────────────────
// 变换操作
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 获取强调节点的首尾 EmphasisMark（只遍历直接子节点，避免嵌套时误取内层标记）。
 */
function getOuterMarks(
  node: SyntaxNode
): { startMark: SyntaxNode; endMark: SyntaxNode } | null {
  const marks: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === NODE_MARK) marks.push(child);
  }
  if (marks.length < 2) return null;
  return { startMark: marks[0]!, endMark: marks[marks.length - 1]! };
}

function removeEmphasis(view: EditorView, node: SyntaxNode): boolean {
  const m = getOuterMarks(node);
  if (!m) return false;
  view.dispatch({
    changes: [
      { from: m.startMark.from, to: m.startMark.to, insert: '' },
      { from: m.endMark.from, to: m.endMark.to, insert: '' }
    ]
  });
  return true;
}

function wrapSelection(view: EditorView, kind: EmphasisKind): boolean {
  const { from, to } = view.state.selection.main;
  const marker = markerFor(kind);
  view.dispatch({
    changes: [
      { from, insert: marker },
      { from: to, insert: marker }
    ],
    selection: { anchor: from + marker.length, head: to + marker.length }
  });
  return true;
}

function insertPair(view: EditorView, marker: string): boolean {
  const { from } = view.state.selection.main;
  view.dispatch({
    changes: { from, insert: marker + marker },
    selection: { anchor: from + marker.length }
  });
  return true;
}

// ──────────────────────────────────────────────────────────────────────────────
// 空选区处理
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 光标紧邻 `_` 时插入下划线，否则默认星号。
 * 这样 `_foo_` 之后继续按 Mod-b，会得到 `_foo__…__` 而不是 `_foo_**…**`。
 */
function pickInsertMarker(doc: Text, pos: number, kind: EmphasisKind): string {
  const star = kind === 'bold' ? '**' : '*';
  const under = kind === 'bold' ? '__' : '_';
  const prev = pos > 0 ? doc.sliceString(pos - 1, pos) : '';
  const next = pos < doc.length ? doc.sliceString(pos, pos + 1) : '';
  return prev === '_' || next === '_' ? under : star;
}

/**
 * 空选区：文本级标记对检测。
 *  `*` 与 `_` 都尝试；命中对称的一对就删除一层，否则插入。
 *  保留原版"无奇偶校验"语义：**|** 按 Mod-i 仍会剥掉一层 * 变成 *|*。
 */
function handleEmptySelection(view: EditorView, kind: EmphasisKind): boolean {
  const pos = view.state.selection.main.from;
  const doc = view.state.doc;
  const candidates = kind === 'bold' ? ['**', '__'] : ['*', '_'];

  for (const marker of candidates) {
    if (pairAt(doc, pos, marker)) {
      const len = marker.length;
      view.dispatch({
        changes: [
          { from: pos - len, to: pos, insert: '' },
          { from: pos, to: pos + len, insert: '' }
        ],
        selection: { anchor: pos - len }
      });
      return true;
    }
  }

  return insertPair(view, pickInsertMarker(doc, pos, kind));
}

// ──────────────────────────────────────────────────────────────────────────────
// 命令工厂
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 生成一个可复用的 CM6 命令。
 *
 * 执行顺序：
 *  1. 选区/光标 ⊆ 目标强调节点 → 解包
 *  2. 非空选区 + 选区内唯一目标节点且紧贴边界 → 解包（`***bold***` 全选）
 *  3. 空选区 → 文本级标记对检测
 *  4. 其余 → 包裹选区
 */
export function toggleEmphasis(kind: EmphasisKind): Command {
  return (view) => {
    const { state } = view;
    const { from, to, empty } = state.selection.main;
    const tree = syntaxTree(state);

    const containing = findContainingEmphasis(tree, from, to, kind);
    if (containing) return removeEmphasis(view, containing);

    if (!empty) {
      const enclosed = findEnclosedEmphasis(tree, from, to, kind);
      if (enclosed) return removeEmphasis(view, enclosed);
    }

    if (empty) return handleEmptySelection(view, kind);

    return wrapSelection(view, kind);
  };
}

/** 现成的粗体命令：`Mod-b` */
export const toggleBold: Command = toggleEmphasis('bold');

/** 现成的斜体命令：`Mod-i` */
export const toggleItalic: Command = toggleEmphasis('italic');

// ──────────────────────────────────────────────────────────────────────────────
// 扩展入口
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 注册插件。默认自动绑定 `Mod-b` / `Mod-i`；
 * 若宿主已有一套 keymap，可传 `{ bindKeymap: false }` 后自行绑定
 * `toggleBold` / `toggleItalic`。
 */
export function markdownEmphasis(options: EmphasisOptions = {}): Extension {
  const { bindKeymap = true } = options;
  if (!bindKeymap) return [];
  return keymap.of([
    { key: 'Mod-b', run: toggleBold, preventDefault: true },
    { key: 'Mod-i', run: toggleItalic, preventDefault: true }
  ]);
}