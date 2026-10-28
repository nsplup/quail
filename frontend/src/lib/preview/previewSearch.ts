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
 *   匹配数量均有保护上限；
 * - 正则安全校验（参考外部 HTML Playground 的 buildSearchPattern）：
 *   面板正则先经 safe-regex 做 ReDoS（灾难性回溯）检测，再做零宽守卫
 *   （模式本身能匹配空字符串则拒绝），不安全模式直接拦截不上岗。
 */
import safeRegex from "safe-regex";
import { writable } from "svelte/store";
import type { RootContent, Element } from "hast";
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

/** 正则安全校验结论（null = 通过；否则为拦截原因） */
export type RegexSafetyIssue = "redos" | "zeroWidth";

/** 由查找条件构建预览区匹配正则（null = 空条件；bad = 正则语法无效；unsafe = 被安全校验拦截） */
export function buildPreviewPattern(o: PreviewPatternOpts): {
  re: RegExp | null;
  bad: boolean;
  unsafe: RegexSafetyIssue | null;
} {
  const term = o.search;
  if (!term) return { re: null, bad: false, unsafe: null };
  let src = o.regexp ? term : escapeRegExp(term);
  if (o.wholeWord) src = `\\b(?:${src})\\b`;
  let re: RegExp;
  try {
    re = new RegExp(src, o.caseSensitive ? "g" : "gi");
  } catch {
    return { re: null, bad: true, unsafe: null };
  }
  /* 安全校验（仅正则模式）：ReDoS 检测 + 零宽守卫，任一命中即拦截 */
  if (o.regexp) {
    let isSafe: boolean;
    try {
      isSafe = safeRegex(term);
    } catch {
      return { re: null, bad: false, unsafe: "redos" };
    }
    if (!isSafe) return { re: null, bad: false, unsafe: "redos" };
  }
  /* 零宽守卫：模式本身能匹配空字符串 → 拒绝（避免匹配循环空转） */
  re.lastIndex = 0;
  const matchesEmpty = re.test("");
  re.lastIndex = 0;
  if (matchesEmpty) return { re: null, bad: false, unsafe: "zeroWidth" };
  return { re, bad: false, unsafe: null };
}

/** 正则安全校验快捷入口（面板侧在构建匹配列表前先行判断拦截原因） */
export function checkRegexSafety(o: PreviewPatternOpts): RegexSafetyIssue | null {
  return buildPreviewPattern(o).unsafe;
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
  /** 面板打开且预览区存在匹配时激活装饰（与当前项来源无关） */
  active: boolean;
  re: RegExp | null;
  /** 当前项下标（列表内 0-based；-1 = 无当前项；当前项来源=编辑区时恒为 -1） */
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

function markNode(id: number, children: RootContent[]): RootContent {
  return {
    type: "element",
    tagName: "mark",
    properties: {
      className: ["pv-search-hl"],
      "data-mid": String(id),
    },
    children,
  } as unknown as RootContent;
}

/* 装饰结果缓存：VirtualList 重挂载 / Svelte 重算时，若 seg 引用与命中
   内容不变，返回同一对象数组——下游 {#each (child)} 的 key 稳定，
   MarkdownNode / CodeBlock 不销毁重建（消除重挂载瞬间的着色闪烁：
   CodeBlock 实例复用则 html 状态保留，不回落纯文本）。
   WeakMap 以 seg 为键：segments$ 增量更新导致 seg 对象重建时自然失效。 */
const decorateCache = new WeakMap<
  HastSegment,
  { key: string; result: RootContent[] }
>();

export function decorateSegmentNodes(
  seg: HastSegment,
  segIndex: number,
  state: PreviewSearchState,
): RootContent[] {
  if (!state.active || !state.re || state.info.total === 0) return seg.nodes;
  const { info } = state;
  const base = info.base[segIndex] ?? 0;
  if (base >= info.total) return seg.nodes;
  const hits: Array<{ s: number; e: number; id: number }> = [];
  for (let id = base; id < info.total; id++) {
    if (info.segOf[id] !== segIndex) break;
    const [s, e] = info.ranges[id];
    hits.push({ s, e, id });
  }
  if (hits.length === 0) return seg.nodes;

  let key = "";
  for (const h of hits) key += `|${h.id}:${h.s}:${h.e}`;
  const cached = decorateCache.get(seg);
  if (cached && cached.key === key) return cached.result;

  const result = applyMarks(seg, hits); // 不再传 state.current
  decorateCache.set(seg, { key, result });
  return result;
}

/* 原装饰逻辑主体（hits / current 由缓存入口计算，与原实现等价） */
function applyMarks(
  seg: HastSegment,
  hits: Array<{ s: number; e: number; id: number }>,
): RootContent[] {
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
    const node = n as {
      type?: string;
      value?: unknown;
      children?: RootContent[];
    };
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
          pieces.push({
            type: "text",
            value: value.slice(pos - start, h.s - start),
          });
        }
        const ms = Math.max(h.s, start);
        const me = Math.min(h.e, end);
        pieces.push(
          markNode(h.id, [
            { type: "text", value: value.slice(ms - start, me - start) },
          ]),
        );
        pos = me;
      }
      if (pos < end)
        pieces.push({ type: "text", value: value.slice(pos - start) });
      return pieces;
    }
    if (
      node.type === "element" &&
      Array.isArray(node.children) &&
      node.children.length > 0
    ) {
      const children = wrapNodes(node.children);
      if (children === node.children) return [n];
      return [{ ...node, children } as unknown as RootContent];
    }
    return [n];
  };

  return wrapNodes(seg.nodes);
}

/* ------------------------------------------------------------------
 *  自渲染分支（CodeBlock 等）的高亮接回工具
 *
 *  装饰器（decorateSegmentNodes）会把 mark 切进 pre>code 的 HAST 子树，
 *  但 CodeBlock 不走 MarkdownNode 通用元素递归渲染，而是自渲染：
 *  着色路径 {@html worker 输出}、降级路径 {plain}，mark 都不参与。
 *  下面两个函数供这类组件把 mark「读出来 + 接回去」：
 *  - extractMarkRanges：从装饰后的 HAST 提取命中区间（plain 文本偏移口径）；
 *  - injectMarksIntoHtml：对着色 HTML 做 plain 偏移 → HTML 偏移映射后插入标签。
 * ------------------------------------------------------------------ */

export interface CodeMarkRange {
  /** 匹配项全局 id（info.ranges 下标，即 data-mid） */
  id: number;
  /** 展平纯文本（collectText 同序口径）中的 [start, end) */
  start: number;
  end: number;
}

/**
 * 从装饰后的 HAST 元素提取 mark 区间。
 * 遍历顺序与文本展平顺序一致（text 计入偏移，element 递归），
 * 因此返回的偏移可直接用于 plain.slice / 注射点定位。
 * 面板关闭 / 无命中时装饰器原样返回子树 → 返回空数组。
 */
export function extractMarkRanges(el: Element | undefined): CodeMarkRange[] {
  const out: CodeMarkRange[] = [];
  if (!el) return out;
  let off = 0;
  const walk = (nodes: RootContent[]): void => {
    for (const n of nodes) {
      const node = n as {
        type?: string;
        value?: unknown;
        children?: RootContent[];
        tagName?: string;
        properties?: Record<string, unknown>;
      };
      if (node.type === "text") {
        off += String(node.value ?? "").length;
        continue;
      }
      if (node.type !== "element" || !Array.isArray(node.children)) continue;
      const isMark = node.tagName === "mark";
      const start = off;
      walk(node.children);
      if (isMark) {
        // 与 markNode 的 properties 写法保持一致（"data-mid"）；
        // 兜底读 dataMid，防 MarkdownNode 序列化层做驼峰映射
        const raw = node.properties?.["data-mid"] ?? node.properties?.dataMid;
        const mid = Number(raw);
        if (Number.isFinite(mid)) out.push({ id: mid, start, end: off });
      }
    }
  };
  walk(el.children);
  return out;
}

/**
 * 向着色 HTML 注入 <mark class="pv-search-hl">。
 *
 * - ranges：extractMarkRanges 的产物（plain 文本偏移）；
 * - current：当前项 id（命中则补 pv-search-current 类）；
 * - 映射规则：跳过 <tag>，实体（&amp; / &#39; / &lt; 等）按 1 个 plain
 *   字符计；这要求 html 的转义符恰为 hljs 输出的常规集合（仅 class
 *   属性的 span + 文本转义，无注释、无含 > 的属性值）。
 * - 输入 html 必须是可信来源（hljs 输出），本函数只插入固定字面量
 *   <mark ...>/</mark>，不引入注入通道。
 */
export function injectMarksIntoHtml(
  html: string,
  ranges: CodeMarkRange[],
  current: number,
): string {
  if (!html || ranges.length === 0) return html;

  /* 1) 扫描 html，产出 plain 字符 → html [start, end) 的映射表。
        spans[i] = 第 i 个 plain 字符在 html 中的区间 */
  const spans: Array<{ start: number; end: number }> = [];
  const n = html.length;
  let i = 0;
  while (i < n) {
    if (html[i] === "<") {
      const gt = html.indexOf(">", i);
      i = gt === -1 ? n : gt + 1; // 标签整体跳过
      continue;
    }
    let j = i;
    while (j < n && html[j] !== "<") j++;
    let k = i;
    while (k < j) {
      if (html[k] === "&") {
        const semi = html.indexOf(";", k);
        if (semi !== -1 && semi < j &&
            /^(?:#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*)$/.test(
              html.slice(k + 1, semi))) {
          spans.push({ start: k, end: semi + 1 }); // 实体 = 1 个 plain 字符
          k = semi + 1;
          continue;
        }
      }
      spans.push({ start: k, end: k + 1 }); // 普通 ASCII 字符
      k += 1;
    }
    i = j;
  }

  /* 2) 匹配区间 → 注入事件：按「HTML 文本 run」切分。
        相邻 plain 字符在 html 中无标签分隔（spans[p-1].end === spans[p].start）
        → 同 run；否则 run 断开，需闭合前一对 mark、开启新一对。
        多 span 跨界时产生多对 <mark>（相同 data-mid），视觉连续、
        HTML 结构合法（mark 不再跨标签）。 */
  interface InjectEvent { pos: number; s: string; isClose: boolean }
  const events: InjectEvent[] = [];
  for (const r of ranges) {
    if (r.end <= r.start || r.end > spans.length) continue;
    const cls = r.id === current
      ? "pv-search-hl pv-search-current"
      : "pv-search-hl";
    const openTag = `<mark class="${cls}" data-mid="${r.id}">`;

    let runStart = r.start;
    for (let p = r.start + 1; p <= r.end; p++) {
      const isLast = p === r.end;
      const sameRun = !isLast && spans[p - 1].end === spans[p].start;
      if (sameRun) continue;
      // run 结束：闭合当前 run 的 mark
      events.push({ pos: spans[runStart].start, s: openTag, isClose: false });
      events.push({ pos: spans[p - 1].end, s: "</mark>", isClose: true });
      runStart = p;
    }
  }
  if (events.length === 0) return html;

  /* 3) 同位置时 close 先于 open（相邻匹配不嵌套） */
  events.sort((a, b) =>
    a.pos - b.pos ||
    (a.isClose === b.isClose ? 0 : a.isClose ? -1 : 1));

  /* 4) 拼接 */
  let out = "";
  let last = 0;
  for (const ev of events) {
    out += html.slice(last, ev.pos) + ev.s;
    last = ev.pos;
  }
  return out + html.slice(last);
}