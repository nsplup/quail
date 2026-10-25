/**
 * 预览区查找匹配与高亮装饰（配合 editor/searchPanel.ts 的悬浮面板）。
 *
 * - 匹配列表：对 segments$（HAST 段）逐段展平文本后按模式匹配，
 *   与编辑区（CM6 搜索管线）的匹配列表、当前项下标完全独立；
 * - 高亮装饰：参考外部 HTML Playground 的「Markdown 搜索装饰器」实现——
 *   把命中区间在 HAST 子树内切分成 <mark class="pv-search-hl"> 包裹的
 *   节点，交由 MarkdownNode 通用元素分支渲染。不触碰已挂载 DOM、
 *   与虚拟滚动重挂载 / worker 增量补丁天然兼容；
 * - 段内展平文本与 MarkdownNode 渲染文本同源同序（CodeBlock / 表格 /
 *   图片等自渲染分支除外：计数与导航照常，段内精确高亮降级为块级滚动）；
 * - 全词匹配与编辑区口径一致（\b 词界断言）；零宽匹配、超大文本与
 *   匹配数量均有保护上限。
 */
import { writable } from "svelte/store";
import type { RootContent } from "hast";
import type { HastSegment } from "../markdown/markdown-core";

/** 匹配列表显示上限（超出显示 999+，超出部分不再参与导航/高亮） */
export const PREVIEW_MATCH_CAP = 999;
/** 单段展平文本长度上限：超过则该段跳过匹配（防灾难性回溯拖垮主线程） */
const MAX_TEXT_LENGTH = 500_000;

export type SearchSource = "editor" | "preview";

/* ------------------------------------------------------------------
 *  模式构建
 * ------------------------------------------------------------------ */

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface PreviewPatternOpts {
  search: string;
  caseSensitive: boolean;
  regexp: boolean;
  wholeWord: boolean;
}

/** 由查找条件构建预览区匹配正则（null = 空条件；bad = 正则无效） */
export function buildPreviewPattern(o: PreviewPatternOpts): {
  re: RegExp | null;
  bad: boolean;
} {
  const term = o.search;
  if (!term) return { re: null, bad: false };
  let src = o.regexp ? term : escapeRegExp(term);
  if (o.wholeWord) src = `\\b(?:${src})\\b`;
  try {
    return { re: new RegExp(src, o.caseSensitive ? "g" : "gi"), bad: false };
  } catch {
    return { re: null, bad: true };
  }
}

/* ------------------------------------------------------------------
 *  匹配列表（HAST 文本展平）
 * ------------------------------------------------------------------ */

/** HAST 子树 → 展平文本（与 MarkdownNode 渲染文本同源同序） */
export function flattenHastText(nodes: RootContent[]): string {
  let out = "";
  const visit = (n: unknown): void => {
    if (!n || typeof n !== "object") return;
    const node = n as { type?: string; value?: unknown; children?: unknown[] };
    if (node.type === "text") {
      out += String(node.value ?? "");
      return;
    }
    if (Array.isArray(node.children)) for (const c of node.children) visit(c);
  };
  for (const n of nodes) visit(n);
  return out;
}

/** 在展平文本中查找全部命中区间（零宽保护 + 数量上限；re 须带 g 标志） */
export function findRanges(
  text: string,
  re: RegExp,
  cap = PREVIEW_MATCH_CAP,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex++; // 零宽匹配：强制前进，避免死循环
      continue;
    }
    out.push([m.index, m.index + m[0].length]);
    if (out.length >= cap) break;
  }
  re.lastIndex = 0;
  return out;
}

export interface PreviewMatchInfo {
  /** 列表内匹配数（真实总数超过上限时等于上限） */
  total: number;
  /** 真实总数超出显示上限 */
  overflow: boolean;
  /** segOf[id] = 第 id 项匹配所在的段下标 */
  segOf: number[];
  /** base[i] = 第 i 段之前累计的匹配数（段内高亮的 data 定位基准） */
  base: number[];
  /** ranges[id] = 第 id 项在段内展平文本中的 [start, end) */
  ranges: Array<[number, number]>;
}

export function emptyPreviewMatchInfo(): PreviewMatchInfo {
  return { total: 0, overflow: false, segOf: [], base: [], ranges: [] };
}

/** 对全部段做匹配计算（列表构建的唯一入口；re 为 null 时返回空列表） */
export function computePreviewMatches(
  segments: HastSegment[],
  re: RegExp | null,
): PreviewMatchInfo {
  const info = emptyPreviewMatchInfo();
  if (!re || segments.length === 0) return info;
  for (let i = 0; i < segments.length; i++) {
    info.base[i] = info.total;
    if (info.overflow) continue;
    const text = flattenHastText(segments[i].nodes);
    if (text.length > MAX_TEXT_LENGTH) continue;
    const rs = findRanges(text, re);
    for (const r of rs) {
      info.segOf.push(i);
      info.ranges.push(r);
    }
    if (info.total + rs.length > PREVIEW_MATCH_CAP) {
      // 截断到上限：多余项不进入列表（total 保持上限，overflow 置位）
      const keep = PREVIEW_MATCH_CAP - info.total;
      info.segOf.length = PREVIEW_MATCH_CAP;
      info.ranges.length = PREVIEW_MATCH_CAP;
      info.total = PREVIEW_MATCH_CAP;
      info.overflow = true;
      info.base[i] = info.total - Math.min(keep, rs.length);
      continue;
    }
    info.total += rs.length;
  }
  info.base[segments.length] = info.total;
  return info;
}

/* ------------------------------------------------------------------
 *  高亮装饰状态（面板驱动；MarkdownSegment 派生消费）
 * ------------------------------------------------------------------ */

export interface PreviewSearchState {
  /** 面板打开且当前项来源 = 预览区时才激活装饰 */
  active: boolean;
  re: RegExp | null;
  /** 当前项下标（列表内 0-based；-1 = 无当前项） */
  current: number;
  info: PreviewMatchInfo;
}

const IDLE_STATE: PreviewSearchState = {
  active: false,
  re: null,
  current: -1,
  info: emptyPreviewMatchInfo(),
};

/** 预览查找状态（面板写入；MarkdownSegment 派生读取） */
export const previewSearchState$ = writable<PreviewSearchState>(IDLE_STATE);

/** 面板侧写入状态的唯一入口 */
export function setPreviewSearchState(s: PreviewSearchState): void {
  previewSearchState$.set(s);
}

/** 恢复空闲（面板关闭 / 来源切回编辑区） */
export function resetPreviewSearchState(): void {
  previewSearchState$.set(IDLE_STATE);
}

/* ------------------------------------------------------------------
 *  HAST 装饰器：把命中区间切分成 mark 包裹的子树（跨标签切分）
 * ------------------------------------------------------------------ */

function markNode(id: number, isCurrent: boolean, children: RootContent[]): RootContent {
  return {
    type: "element",
    tagName: "mark",
    properties: {
      className: isCurrent
        ? ["pv-search-hl", "pv-search-current"]
        : ["pv-search-hl"],
      "data-mid": String(id),
    },
    children,
  } as unknown as RootContent;
}

/**
 * 对段节点做装饰。返回值：
 * - 与入参同引用（无命中 / 未激活）→ Svelte 跳过该子树；
 * - 新数组（含 mark）→ 交由 MarkdownNode 递归渲染。
 * 偏移推进与 flattenHastText 完全同序（text 计入，element 递归）。
 */
export function decorateSegmentNodes(
  seg: HastSegment,
  segIndex: number,
  state: PreviewSearchState,
): RootContent[] {
  if (!state.active || !state.re || state.info.total === 0) return seg.nodes;
  const { info } = state;
  const base = info.base[segIndex] ?? 0;
  if (base >= info.total) return seg.nodes;
  // 收集本段命中的带 id 区间
  const hits: Array<{ s: number; e: number; id: number }> = [];
  for (let id = base; id < info.total; id++) {
    if (info.segOf[id] !== segIndex) break;
    const [s, e] = info.ranges[id];
    hits.push({ s, e, id });
  }
  if (hits.length === 0) return seg.nodes;

  const offset = { value: 0 };
  const wrapNodes = (nodes: RootContent[]): RootContent[] => {
    let changed = false;
    const out: RootContent[] = [];
    for (const n of nodes) {
      const wrapped = wrapNode(n);
      if (wrapped.length === 1 && wrapped[0] === n) {
        out.push(n);
      } else {
        changed = true;
        for (const w of wrapped) out.push(w);
      }
    }
    return changed ? out : nodes;
  };
  const wrapNode = (n: RootContent): RootContent[] => {
    const node = n as { type?: string; value?: unknown; children?: RootContent[] };
    if (node.type === "text") {
      const value = String(node.value ?? "");
      const start = offset.value;
      const end = start + value.length;
      offset.value = end;
      const pieces: RootContent[] = [];
      let pos = start;
      for (const h of hits) {
        if (h.e <= pos) continue;
        if (h.s >= end) break;
        if (h.s > pos) {
          pieces.push({ type: "text", value: value.slice(pos - start, h.s - start) });
        }
        const ms = Math.max(h.s, start);
        const me = Math.min(h.e, end);
        pieces.push(markNode(h.id, h.id === state.current, [
          { type: "text", value: value.slice(ms - start, me - start) },
        ]));
        pos = me;
      }
      if (pos < end) pieces.push({ type: "text", value: value.slice(pos - start) });
      return pieces;
    }
    if (node.type === "element" && Array.isArray(node.children) && node.children.length > 0) {
      const children = wrapNodes(node.children);
      if (children === node.children) return [n];
      return [{ ...node, children } as unknown as RootContent];
    }
    return [n];
  };
  return wrapNodes(seg.nodes);
}
