/**
 * Markdown 源码 → mdast AST → 预览块 HTML。
 *
 * 约定（与产品需求一致）：
 * - AST 只从源码单向构建，绝不反向写回源码；
 * - 保存时永远使用 Markdown 源码本身；
 * - 同步滚动、大纲、预览渲染全部依赖这份 AST 的位置信息。
 */
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { toHast } from "mdast-util-to-hast";
import { toHtml } from "hast-util-to-html";
import { raw as rehypeRaw } from "hast-util-raw";
import type { Root as HastRoot, ElementContent as HastContent } from "hast";
import type { Root, RootContent, Content, PhrasingContent, Image } from "mdast";
import type { PreviewBlock, OutlineItem } from "./types";
import { rewriteImageSrc } from "./imgproxy";

const processor = unified().use(remarkParse).use(remarkGfm);

/** 从 Markdown 源码解析出 mdast AST（含 GFM 扩展：表格 / 任务列表 / 删除线 / 自动链接 / 脚注） */
export function parseMarkdown(src: string): Root {
  return processor.parse(src) as unknown as Root;
}

/**
 * 整篇 mdast → hast → rehype-raw 融合（社区成熟链路：remark-rehype / rehype-raw）。
 * raw HTML（如 <details>）在 HAST 层被自动融合成完整 element 树，
 * 内部 markdown 是其 children——无需任何手写 details 扫描/合并逻辑。
 */
/** 顶层行号锚点 comment 前缀（块分块用，渲染前剥除） */
const MDL = "mdl:";

interface RawResult {
  hast: HastRoot;
  /** 树中存在 raw HTML（rehype-raw 执行过融合） */
  hasRaw: boolean;
}

function mdastToHastRaw(root: Root): RawResult {
  const hast = toHast(root as never, {
    allowDangerousHtml: true,
    // <img> → <md-image>（原生自定义元素，见 md-image.ts）：
    // data-src 经 ImgProxy 重写（本地白名单 / 远程缓存），
    // 浏览器解析 {@html} 时自动实例化，零框架运行时。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handlers: {
      // 签名：handler(state, node, parent) —— 第一个参数是 state 上下文
      image: ((_state: never, node: Image) =>
        ({
          type: "element",
          tagName: "md-image",
          properties: {
            "data-src": rewriteImageSrc(node.url),
            "data-alt": node.alt ?? "",
          },
          children: [],
        }) as unknown as HastContent) as never,
    } as never,
  }) as HastRoot;
  const hasRaw = (hast.children as HastContent[]).some((n) => n.type === "raw");
  // 在每个顶层节点前注入 mdast 行号锚：rehype-raw 的整树重解析会丢弃 position，
  // 但 HTML 注释会被 parse5 原样保留，从而在融合后的树上恢复行号。
  const anchored = { type: "root", children: [] as HastContent[] } as unknown as HastRoot;
  for (const n of hast.children as HastContent[]) {
    if (n.position) {
      anchored.children.push({
        type: "comment",
        value: `${MDL}${n.position.start.line}:${n.position.end.line}`,
      } as HastContent);
    }
    anchored.children.push(n);
  }
  return { hast: rehypeRaw(anchored as never) as HastRoot, hasRaw };
}

/** hast 元素/文本节点类型名（预览块 type 仅供展示/调试） */
function hastType(node: HastContent): string {
  if (node.type === "element") return (node as { tagName?: string }).tagName ?? "element";
  return node.type;
}

/** 递归剥除锚点 comment（输出 HTML 必须干净） */
function stripAnchors(node: HastContent): void {
  const kids = (node as { children?: HastContent[] }).children;
  if (kids) {
    const kept = kids.filter(
      (c) => !(c.type === "comment" && (c as { value: string }).value.startsWith(MDL))
    );
    (node as { children: HastContent[] }).children = kept;
    kept.forEach(stripAnchors);
  }
}

/** 单个 HAST 顶层节点 → HTML（rehype-stringify 核心 hast-util-to-html） */
function renderHastNode(node: HastContent): string {
  try {
    return toHtml(node as never);
  } catch {
    const pos = (node as { position?: { start?: { line?: number } } }).position;
    return `<p class="render-error">[render error @ line ${pos?.start?.line ?? "?"}]</p>`;
  }
}

const htmlMemo = new Map<string, string>();
const MEMO_MAX = 4096;

function memoHtml(key: string, node: HastContent): string {
  const cached = htmlMemo.get(key);
  if (cached !== undefined) return cached;
  const html = renderHastNode(node);
  if (htmlMemo.size >= MEMO_MAX) {
    // 简单防膨胀：清掉最早的一半
    let drop = htmlMemo.size >> 1;
    for (const k of htmlMemo.keys()) {
      htmlMemo.delete(k);
      if (--drop <= 0) break;
    }
  }
  htmlMemo.set(key, html);
  return html;
}

/** FNV-1a 32bit：内容键只用做 Map 键与 id，不参与安全场景 */
function hashStr(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36) + "_" + s.length.toString(36);
}

/** AST 顶层节点 → 虚拟滚动用的预览块列表（需要源码以计算内容键） */
/**
 * HAST 顶层节点 → 预览块（行号来自顶层锚点 comment；区间无缝覆盖全部源行，
 * 满足增量解析对块边界的连续性要求）。
 */
function blocksFromHast(
  raw: RawResult,
  srcForHash: string,
  baseLine = 0
): { blocks: PreviewBlock[]; fused: boolean } {
  const seen = new Map<string, number>();
  const top = raw.hast.children as HastContent[];
  // 锚跟随其后的首个内容节点；行号区间 = 本锚 start .. 下一锚 start - 1（无缝覆盖）
  const blocks: PreviewBlock[] = [];
  let pending: { start: number; end: number } | null = null;
  let pendingHtml: { node: HastContent; clean: HastContent } | null = null;
  let fused = false;

  const emit = (endLine: number): void => {
    if (!pending || !pendingHtml) return;
    const { node, clean } = pendingHtml;
    const html = toHtml(clean as never);
    const contentKey = hastType(clean) + "\u0000" + hashStr(html);
    const nth = seen.get(contentKey) ?? 0;
    seen.set(contentKey, nth + 1);
    blocks.push({
      id: `${contentKey}#${nth}`,
      index: blocks.length,
      type: hastType(clean),
      html: memoHtml(contentKey, clean),
      startLine: pending.start + baseLine,
      endLine: endLine + baseLine,
    });
    void node;
    pending = null;
    pendingHtml = null;
  };

  for (const n of top) {
    if (n.type === "comment") {
      const v = (n as { value: string }).value;
      if (v.startsWith(MDL)) {
        // 新锚：结算上一块（区间到本锚 start - 1），挂新锚
        const [a, b] = v.slice(MDL.length).split(":").map(Number);
        if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
        if (pending) emit(a - 1);
        pending = { start: a, end: b };
        pendingHtml = null;
        continue;
      }
    }
    if (n.type === "text" && !(n as { value?: string }).value?.trim()) continue;
    if (pendingHtml) continue; // 同一锚下的多余节点（罕见）：保守跳过
    if (!pending) {
      fused = true; // 无锚可挂（不应发生）
      continue;
    }
    const clean = structuredClone(n);
    stripAnchors(clean);
    pendingHtml = { node: n, clean };
  }
  if (pending) emit(pending.end);
  void srcForHash;
  return { blocks, fused };
}

export function buildBlocks(root: Root, src: string): PreviewBlock[] {
  return blocksFromHast(mdastToHastRaw(root), src).blocks;
}

function textOf(node: PhrasingContent | RootContent | null | undefined): string {
  if (!node) return "";
  const n = node as unknown as Record<string, unknown>;
  if (n.type === "text" || n.type === "inlineCode" || n.type === "html") {
    return String(n.value ?? "");
  }
  if (Array.isArray(n.children)) {
    return (n.children as PhrasingContent[]).map(textOf).join("");
  }
  return "";
}

/** mdast → 大纲（标题层级树，按行号定位）。块索引经行号映射到 HAST 分块 */
export function buildOutline(root: Root, blocks: PreviewBlock[]): OutlineItem[] {
  const items: OutlineItem[] = [];
  root.children.forEach((node) => {
    if (node.type === "heading" && node.position) {
      const line = node.position.start.line;
      items.push({
        depth: node.depth,
        text: textOf(node).trim() || `H${node.depth}`,
        line,
        blockIndex: blockIndexForLine(blocks, line),
      });
    }
  });
  return items;
}

/**
 * 行号 → 预览块下标（二分查找：找到 startLine <= line 的最后一个块）。
 * 用于「编辑器 → 预览」的同步滚动。
 */
export function blockIndexForLine(blocks: PreviewBlock[], line: number): number {
  let lo = 0;
  let hi = blocks.length - 1;
  let res = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (blocks[mid].startLine <= line) {
      res = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return res;
}

/* ---------------- 增量解析：行级 diff → 仅重解析受影响的顶层块 ----------------
 *
 * 全量 parse 在大文档上每次按键都有可感延迟。这里做块级增量：
 * 1. 行级公共前缀/后缀 diff 定位变化行区间；
 * 2. 映射到旧的顶层块区间 [i0, i1]，并按容器延续规则（列表/引用/表格/围栏）
 *    向外扩展，代码围栏未闭合时扩展到开启行/文末；
 * 3. 只对该区间的源码做局部 parse，拼接出新 blocks 与新 root（行号平移修正）；
 * 4. 块 id 基于内容键 + 出现序号，未编辑块 id 与 html 引用均不变 →
 *    预览端 keyed/VList 渲染只触碰真正变化的块（增量渲染）。
 * 兜底：每 25 次增量或调用方 idle 时强制全量解析，防止启发式误差累积。
 */

export interface IncrementalParseState {
  src: string;
  root: Root | null;
  blocks: PreviewBlock[];
}

export interface IncrementalParseResult {
  root: Root;
  blocks: PreviewBlock[];
  full: boolean;
}

/** 可能与前一顶层块延续成同一容器的行首特征 */
const CONT_RE = /^\s*(?:[-*+]|\d{1,9}[.)]|>|(?:```+|~~~+))\s*/;
const FENCE_RE = /^\s{0,3}(```+|~~~+)/;

/** lines[0..end) 的未闭合围栏 → 返回开启行（1-based）或 -1 */
function openFenceLine(lines: string[], end: number): number {
  let openLine = -1;
  let fence = "";
  for (let i = 0; i < end && i < lines.length; i++) {
    const m = lines[i].match(FENCE_RE);
    if (m) {
      if (openLine === -1) {
        openLine = i + 1;
        fence = m[1][0];
      } else if (m[1][0] === fence) {
        openLine = -1;
        fence = "";
      }
    }
  }
  return openLine;
}

function parseRange(
  src: string,
  lines: string[],
  fromLine: number,
  toLine: number,
  baseLine: number
): { children: RootContent[]; blocks: PreviewBlock[] | null } {
  const chunk = lines.slice(fromLine - 1, toLine).join("\n");
  const root = processor.parse(chunk) as unknown as Root;
  const parsed = mdastToHastRaw(root);
  // 局部 chunk 含 raw HTML（rehype-raw 融合）时块边界可能跨越区间外 → 保守全量
  const { blocks, fused } = parsed.hasRaw
    ? { blocks: null as PreviewBlock[] | null, fused: false }
    : blocksFromHast(parsed, chunk, baseLine);
  // occurrence 去重由调用方统一处理；无法可靠映射 → 调用方保守全量
  return {
    children: root.children,
    blocks: fused || !blocks ? null : blocks.map((b) => ({ ...b, id: b.id.split("#")[0] })),
  };
}

export function buildBlocksIncremental(
  prev: IncrementalParseState,
  nextSrc: string,
  forceFull: boolean
): IncrementalParseResult {
  const runFull = (): IncrementalParseResult => {
    const root = parseMarkdown(nextSrc);
    return { root, blocks: buildBlocks(root, nextSrc), full: true };
  };

  if (forceFull || !prev.root || !prev.src || prev.blocks.length === 0) {
    return runFull();
  }
  const prevBlocks = prev.blocks;

  const prevLines = prev.src.split("\n");
  const nextLines = nextSrc.split("\n");
  const minLen = Math.min(prevLines.length, nextLines.length);

  // 行级公共前缀/后缀
  let p = 0;
  while (p < minLen && prevLines[p] === nextLines[p]) p++;
  let s = 0;
  while (
    s < minLen - p &&
    prevLines[prevLines.length - 1 - s] === nextLines[nextLines.length - 1 - s]
  ) {
    s++;
  }

  // 变化行区间（1-based，含）：prev [p+1, prevEnd]，next [p+1, nextEnd]（可能为空）
  const prevChgStart = p + 1;
  const prevChgEnd = prevLines.length - s;
  const delta = nextLines.length - prevLines.length;
  if (prevChgEnd < prevChgStart && delta === 0) return runFull(); // 内容相同（不应发生）

  // 变化区间 → 相交旧块区间 [i0, i1]（可为空：i0 = i1 + 1）
  let i0 = prevBlocks.findIndex((b) => b.endLine >= prevChgStart);
  if (i0 === -1) i0 = prevBlocks.length;
  let i1 = prevBlocks.length - 1;
  while (i1 >= 0 && prevBlocks[i1].startLine > prevChgEnd) i1--;

  // ---- 重解析区间（新文档行号）：锚定在未受影响块的边界上 ----
  // 起点：i0-1 块的末行 + 1（该行 < prevChgStart ≤ p+1，行号不变）
  let nextStart = i0 === 0 ? 1 : prevBlocks[i0 - 1].endLine + 1;
  // 终点：i1+1 块的首行 - 1（该行 > prevChgEnd，需 +delta 平移）
  let nextEnd =
    i1 === prevBlocks.length - 1
      ? nextLines.length
      : prevBlocks[i1 + 1].startLine + delta - 1;

  // 容器延续扩展：列表/引用/表格/围栏跨越块边界时，受影响范围向外扩
  const headContinues = (): boolean => {
    const firstChanged = nextLines[nextStart - 1] ?? "";
    const prevTail =
      i0 > 0 ? prevLines[Math.min(prevBlocks[i0 - 1].endLine, prevLines.length) - 1] : "";
    return CONT_RE.test(firstChanged) || CONT_RE.test(prevTail);
  };
  const tailContinues = (): boolean => {
    const lastChanged = nextLines[nextEnd - 1] ?? "";
    const nextHead =
      i1 + 1 < prevBlocks.length && prevBlocks[i1 + 1].startLine + delta - 1 < nextLines.length
        ? nextLines[prevBlocks[i1 + 1].startLine + delta - 1]
        : "";
    return CONT_RE.test(lastChanged) || CONT_RE.test(nextHead);
  };

  let guard = 0;
  while (headContinues() && i0 > 0 && guard++ < 64) {
    i0--;
    nextStart = i0 === 0 ? 1 : prevBlocks[i0 - 1].endLine + 1;
  }
  guard = 0;
  while (tailContinues() && i1 < prevBlocks.length - 1 && guard++ < 64) {
    i1++;
    nextEnd = i1 === prevBlocks.length - 1
      ? nextLines.length
      : prevBlocks[i1 + 1].startLine + delta - 1;
  }

  // 未闭合围栏：起点之前有开启围栏 → 扩到开启行；区间内未闭合 → 扩到文末
  const fenceBefore = openFenceLine(prevLines, Math.min(nextStart, prevLines.length) - 1);
  if (fenceBefore > 0) {
    const mapped = fenceBefore <= p ? fenceBefore : -1;
    if (mapped > 0) {
      nextStart = Math.min(nextStart, mapped);
      i0 = prevBlocks.findIndex((b) => b.endLine >= nextStart);
      if (i0 === -1) i0 = prevBlocks.length;
    } else {
      return runFull(); // 围栏开启行落在变化区间内，无法安全定位
    }
  }
  {
    const inner = openFenceLine(nextLines.slice(nextStart - 1, nextEnd), nextEnd - nextStart + 1);
    if (inner > 0 && nextEnd < nextLines.length) {
      nextEnd = nextLines.length;
      i1 = prevBlocks.length - 1;
    }
  }

  // ---- 局部 parse + 拼接 ----
  const baseLine = nextStart - 1;
  const local = parseRange(nextSrc, nextLines, nextStart, nextEnd, baseLine);
  if (!local.blocks) return runFull(); // 局部含 raw 融合，无法可靠映射 → 全量

  const headBlocks = prev.blocks.slice(0, i0);
  const tailBlocks = prev.blocks.slice(i1 + 1);

  // 行号平移（尾部块整体 +delta）+ 位置重排
  const blocks: PreviewBlock[] = [...headBlocks, ...local.blocks, ...tailBlocks];
  for (let i = 0; i < blocks.length; i++) {
    blocks[i].index = i;
  }
  for (const b of tailBlocks) {
    b.startLine += delta;
    b.endLine += delta;
  }

  // id 去重（内容相同块按出现序消解）
  const seen = new Map<string, number>();
  for (const b of blocks) {
    const nth = seen.get(b.id) ?? 0;
    seen.set(b.id, nth + 1);
    if (nth > 0) b.id = `${b.id}~${nth}`;
  }

  // 拼接 root.children，并同步修正行号（大纲依赖 position.start.line）
  const children = [
    ...prev.root.children.slice(0, i0),
    ...local.children,
    ...prev.root.children.slice(i1 + 1),
  ];
  for (const node of prev.root.children.slice(i1 + 1)) {
    if (node.position) {
      node.position.start.line += delta;
      node.position.end.line += delta;
    }
  }
  for (const node of local.children) {
    if (node.position) {
      node.position.start.line += baseLine;
      node.position.end.line += baseLine;
    }
  }

  const root: Root = {
    ...prev.root,
    children,
  };
  return { root, blocks, full: false };
}

/** 英文单词匹配 */
/**
 * 校验块行界是否连续覆盖整个文档（1..行数）：
 * 通过 → 增量解析结果与全量一致，无需周期性全量重算（自愈）。
 */
export function blocksCoverDoc(blocks: PreviewBlock[], src: string): boolean {
  const totalLines = src.split("\n").length;
  let expect = 1;
  for (const b of blocks) {
    if (b.startLine !== expect || b.endLine < b.startLine) return false;
    expect = b.endLine + 1;
  }
  return expect - 1 === totalLines;
}

export function countEnglishWords(text: string): number {
  const m = text.match(/[A-Za-z0-9_'’\-]+/g);
  return m ? m.length : 0;
}

/** 汉字匹配（CJK 统一表意文字 + 扩展 A） */
export function countHanCharacters(text: string): number {
  const m = text.match(/[\u3400-\u4DBF\u4E00-\u9FFF]/g);
  return m ? m.length : 0;
}
