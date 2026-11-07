/**
 * Markdown 源码 → mdast → HAST（数据）+ 预览块行界（映射）。
 *
 * 【worker 专属模块】本模块由 parse.worker.ts 引入，在 worker 线程运行；
 * 禁止 import 任何 UI 侧模块（stores / i18n / .svelte / 含 document、window
 * 顶层引用的模块），保证 worker 环境零 DOM 依赖。
 *
 * 约定（与产品需求一致）：
 * - AST 只从源码单向构建，绝不反向写回源码；
 * - 保存时永远使用 Markdown 源码本身；
 * - 同步滚动、大纲、预览渲染全部依赖这份 AST 的位置信息。
 *
 * 渲染管线（Svelte 组件树直渲染，不经 HTML 字符串 / {@html}）：
 *   parseMarkdown → mdastToHastRaw（注入行号锚 + rehype-raw 融合 + rehype-sanitize 净化）→ HAST Root
 *   → splitSegments → 段列表（经结构化克隆回传主线程）
 *   → MarkdownRenderer/MarkdownNode 递归组件 → DOM。
 *   引用体系：定义/脚注定义在 handler 期间收集进 RefsCollector（不渲染
 *   DOM），解析结束全量 finalize 成 RefsSnapshot 随结果回传，主线程全局
 *   STORE（reference-store.ts）供脚注引用 / 链接引用 / 引用式图片组件
 *   渲染期查找；脚注引用与链接引用以数据层标记（md-footnote-ref /
 *   md-link-ref）承载，图片统一为 img 元素（MarkdownNode 映射组件）。
 * 块行界由锚 comment 驱动（blocksFromHast），供滚动同步 / 大纲 / 增量解析使用。
 */
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import remarkMath from "remark-math";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import type { Schema } from "hast-util-sanitize";
import type { Plugin } from "unified";
import { toHast } from "mdast-util-to-hast";
import { raw as rehypeRaw } from "hast-util-raw";
import type {
  Root as HastRoot,
  ElementContent as HastContent,
  Element as HastElement,
  RootContent,
} from "hast";
import type {
  Root,
  RootContent as MdastContent,
  PhrasingContent,
  Image,
  ImageReference,
  Reference,
  Definition,
  FootnoteDefinition,
  FootnoteReference,
  LinkReference,
} from "mdast";
import type { Math, InlineMath } from "mdast-util-math";
import type { PreviewBlock, OutlineItem } from "../types";
import { rewriteImageSrc } from "../imgproxy";
import {
  blockIndexForLine,
  blocksCoverDoc,
  countTextAs,
  splitLines,
} from "./blocks";


/* ---------------- 行内公式空格守卫（$ a $ 非公式） ----------------
 * micromark-extension-math 对行内 $ 不做开闭内侧空白检查，「$ a $」、
 * 「价格 $5 与 $3」这类正文会被整体误吞成 inlineMath。Pandoc / KaTeX
 * auto-render / GitHub 均按「$ 内侧紧邻空白不是公式」处理。
 * 在 mdast transformer 阶段（runSync 内、toHast 之前）把「源码原文 $…$
 * 内侧带空白」的 inlineMath 还原为字面 text（position 原样保留）：
 * - 注册在共享 processor 上，parseMarkdown 与增量 parseRange 全覆盖；
 * - 块级 $$（type "math"）不触碰：$$ 内侧任意空白合法且常见（多行
 *   书写）；行内 $$..$$（remark-math 也产出 type "math"）同样不受影响；
 * - 还原后 inlineMath handler 不会为其产出 md-math → 这些文本可被
 *   预览查找命中（符合 isSearchExcluded 的语义预期）。
 *
 * 【判定必须基于源码原文而非 value】micromark-extension-math v3 的
 * resolveMathText 在「$ 开闭两侧同时紧邻空白」时会把边缘空白转为
 * mathTextPadding token 并排除出 value——「$ a $」的 inlineMath.value
 * 是 "a"（首尾无空白），value 层面与「$a$」无法区分，仅看 value 的
 * 空白守卫对 $ a $ 永远漏判（正文与脚注列表同样失效）。因此 transformer
 * 以 (tree, file) 取源码，按 position.offset 切出 $…$ 原文判定内侧空白；
 * 仅当 position.offset 缺失时退回旧的 value 判定（v2 行为，边缘空白
 * 会保留在 value 中）。 */
function stripSpacedInlineMath(root: Root, src: string): void {
  const visit = (parent: { children?: MdastContent[] }): void => {
    const kids = parent.children;
    if (!Array.isArray(kids)) return;
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i] as {
        type?: string;
        value?: unknown;
        position?: { start?: { offset?: number }; end?: { offset?: number } };
      };
      if (k.type === "inlineMath") {
        const st = k.position?.start?.offset;
        const en = k.position?.end?.offset;
        if (typeof st === "number" && typeof en === "number" && st < en) {
          // 源码原文（含美元符），内侧原文 = 剥去首尾 $ 序列
          const raw = src.slice(st, en);
          const inner = raw.replace(/^\$+/, "").replace(/\$+$/, "");
          if (/^\s/.test(inner) || /\s$/.test(inner)) {
            kids[i] = {
              type: "text",
              value: raw, // 逐字还原源码字面量（含原有空白）
              ...(k.position ? { position: k.position } : {}),
            } as unknown as MdastContent;
            continue;
          }
        } else {
          // 无可靠 offset（防御分支）：退回 value 判定（remark-math v2 语义）
          const v = typeof k.value === "string" ? k.value : "";
          if (/^\s/.test(v) || /\s$/.test(v)) {
            kids[i] = {
              type: "text",
              value: `$${v}$`, // 逐字还原源码字面量（v2 保留内部原文）
              ...(k.position ? { position: k.position } : {}),
            } as unknown as MdastContent;
            continue;
          }
        }
      }
      visit(kids[i] as { children?: MdastContent[] });
    }
  };
  visit(root);
}

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  // 数学公式语法（remark-math）：$...$ → inlineMath、$$...$$ → math。
  // 两者经下方 handler 转为 md-math 自定义元素（LaTeX 源码原样承载），
  // 渲染由 MarkdownNode 分派到 MarkdownMath 组件（MathJax SVG 自渲染）。
  // 预览查找对 md-math 彻底排除匹配（见 previewSearch.ts isSearchExcluded）。
  .use(remarkMath as unknown as Plugin<[]>)
  // 行内公式空格守卫：transformer 在 runSync 阶段对 mdast 执行，
  // 先于 toHast 的 inlineMath handler，误匹配不会进 HAST / md-math。
  // file.value 为本次 parse 的源码（全量 = 全文；增量 = chunk 文本，
  // 二者的 position.offset 均与之一致），见 parseMarkdown / parseRange。
  .use((() => (tree: never, file: unknown) => {
    stripSpacedInlineMath(
      tree as unknown as Root,
      typeof (file as { value?: unknown })?.value === "string"
        ? (file as { value: string }).value
        : "",
    );
  }) as unknown as Plugin<[]>);

/** rehype-slug 专用 processor：transformer 只认 HAST（element + h1..h6），
 *  必须在 toHast 产物上执行——runSync 阶段的树是 mdast，直接 .use 进
 *  主管线是纯 no-op（这正是迁移后锚点失效的原因）。每次 runSync 调用
 *  transformer 一次，slugger 状态按调用独立，全量/增量/例行重建多次
 *  转换不会出现 intro-1 式串号。 */
const slugProcessor = unified().use(rehypeSlug as unknown as Plugin<[]>);

/** Markdown 源码 → mdast AST（含 GFM 扩展：表格 / 任务列表 / 删除线 / 自动链接 / 脚注）。
 * remark 转换阶段（run）在此同步执行：rehype-slug 为标题注入 GitHub 风格 slug id
 * （data.hProperties.id，经 toHast 落为元素 id 属性）——页内锚点跳转的定位依据。
 * 注意：增量路径的局部 chunk 独立 parse，标题 id 去重仅在其 chunk 内生效，
 * 与全量 parse 的文档级去重可能存在差异（锚点跳转取首个命中，且 idle 自愈
 * 全量重建会最终对齐）。 */
export function parseMarkdown(src: string): Root {
  // 源码必须显式传给 run（第二参数）：runSync(tree) 只收树、会新建空
  // VFile，transformer 的 file.value 为空 → 公式守卫无法按 offset 切原文。
  return processor.runSync(processor.parse(src), src) as unknown as Root;
}

/* ---------------- rehype-sanitize 净化 schema ----------------
 * 在 GitHub 向默认白名单（defaultSchema）上做最小扩展，全部为管线
 * 既有产物的存活声明：
 * - allowComments：保留「mdl:」行号锚 comment——块映射 / 滚动同步 /
 *   增量解析 / 大纲的基石，默认 schema 会把注释整体剥除；
 * - clobberPrefix 置空：id 原样保留。默认 schema 会对白名单放行的 id
 *   无条件前缀化 user-content-（脚注 id 由 mdast-util-to-hast 生成时
 *   已自带该前缀，二次前缀化会让脚注锚点失配）；本应用只渲染用户本地
 *   文档，DOM clobbering 风险由 tagNames / attributes / protocols
 *   白名单兜底；
 * - id 显式进 '*' 白名单（默认已含，显式声明固化语义）：标题锚点
 *   （rehype-slug）与脚注定义 / 回链 id 的载体；
 * - md-footnote-ref / md-link-ref 进 tagNames：脚注引用与链接引用
 *   handler 产物的数据层标记标签——只存在于 HAST 数据（渲染层
 *   MarkdownNode 映射为组件，永不进 DOM），未知标签默认被 unwrap，
 *   必须声明才能幸存 sanitize；
 * - data* 进 '*' 属性：img 的 data-src / data-alt / data-ref-* 与
 *   data-inline 等标注（hast 属性键经规范化可能为 dataSrc 或 data-src，
 *   'data*' 通配两者；后者由 annotateImageContext 在净化后写入，
 *   此处仅作声明）。
 */
const sanitizeSchema = {
  ...defaultSchema,
  allowComments: true,
  clobberPrefix: "",
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    "md-footnote-ref",
    "md-link-ref",
    // 数学公式（remark-math handler 产物）：LaTeX 源码承载元素，
    // MarkdownNode 分派 MarkdownMath 组件渲染；查找彻底排除匹配
    "md-math",
  ],
  attributes: {
    ...(defaultSchema.attributes ?? {}),
    "*": [...(defaultSchema.attributes?.["*"] ?? []), "id", "data*"],
  },
} satisfies Schema;

/**
 * 整篇 mdast → hast → rehype-raw 融合（社区成熟链路：remark-rehype / rehype-raw）。
 * raw HTML（如 <details>）在 HAST 层被自动融合成完整 element 树，
 * 内部 markdown 是其 children——无需任何手写 details 扫描/合并逻辑。
 */
/** 顶层行号锚点 comment 前缀（块分块 / 渲染段切分用；渲染组件跳过该 comment） */
const MDL = "mdl:";

interface RawResult {
  hast: HastRoot;
  /** 树中任意深度存在 raw HTML（rehype-raw 执行过融合） */
  hasRaw: boolean;
  /** 本次转换期间由 definition/footnoteDefinition handler 写入的收集器 */
  refsCollector: RefsCollector;
}

/** mdast-util-to-hast state 中本管线消费的最小接口定义
 *  （definitionById：旧 imageReference handler 的转换期定义查找，
 *  已被 STORE 渲染期解析取代；all：子节点转换，供脚注内容收集） */
interface MdastToHastState {
  definitionById: Map<string, { url?: string | null }>;
  /** 转换 node.children（内部按 handlers 递归，产出与主链路同构的 HAST） */
  all(node: { children: MdastContent[] }): HastContent[];
  /** 复制 mdast 节点的 position 到转换产物。顶层块级自定义元素
   *  （md-math）必须带 position，否则锚注入（只认 position）不会给它
   *  生成独立行号锚 → 独立成段/块失效（行内自定义元素无此依赖） */
  patch(from: unknown, to: unknown): void;
}

/* ---------------- 引用声明收集与全局 STORE 快照（worker 侧） ----------------
 *
 * 设计（与产品需求一致）：
 * - definition / footnoteDefinition handler 保持「不渲染 DOM」语义（返回
 *   undefined，原位置无输出），但在 handler 执行期间把声明收集进本次转换
 *   的 RefsCollector（脚注定义的内容经 state.all 转成 HAST，内层引用 /
 *   图片标记自然生成，支持脚注嵌套）；
 * - footnoteReference / linkReference handler 产出数据层标记元素
 *   （md-footnote-ref / md-link-ref，只携带 identifier / label /
 *   referenceType，不带编号与解析结果），渲染层组件从主线程全局 STORE
 *   查找——因此增量解析复用的 head/tail 段引用标记永远不会陈旧，
 *   也修复了旧实现在 chunk 局部转换期间查不到 head/tail 定义而误回退
 *   字面量的问题；
 * - 解析结束时（全量 / 增量 / 例行重建基线采纳）统一 finalize：
 *   按块维护 defsByBlock / refSeqByBlock 基线（与 blockCounts 同模式，
 *   增量只重算被替换块），全量构建 RefsSnapshot 随解析结果回传主线程，
 *   原子更新全局 STORE（见 reference-store.ts）；
 * - 重复定义遵循规范：CommonMark §4.7 与 GFM 脚注扩展均为「首个同名
 *   定义生效」，在快照构建时按文档序首现去重；
 * - label 复杂字符串（CJK 等）：匹配键用 mdast identifier——micromark
 *   在解析期对引用与定义双侧做了同一套规范化（Unicode case fold +
 *   折叠内部空白 + 去首尾空白），CJK 原样保留，直接全等匹配即是规范语义；
 *   字面量回退显示用 label（原始书写形式）。
 */

/** 链接定义声明（[label]: url "title"）——仅用于解析查找，无任何渲染路径 */
export interface LinkDefEntry {
  /** 规范化匹配键（micromark 产出，CJK 原样；引用侧同键全等匹配） */
  identifier: string;
  /** 原始书写 label（字面量回退显示用） */
  label: string;
  url: string;
  title: string | null;
}

/** 脚注定义声明（[^label]: 内容）——内容由主线程组件渲染（支持嵌套） */
export interface FootnoteDefEntry {
  identifier: string;
  label: string;
  /** 定义内容的 HAST 子树（已过 raw 融合 + sanitize + 上下文标注，
   *  内层 md-footnote-ref / md-link-ref / img 标记可被 MarkdownNode 渲染） */
  children: HastContent[];
}

/** 脚注引用统计（按首次引用出现顺序；编号 = 序 + 1，GFM 语义） */
export interface FootnoteRefInfo {
  identifier: string;
  /** 文档内引用出现次数（列表回链数量） */
  count: number;
}

/** 引用声明快照：随解析结果回传，主线程全量更新全局 STORE */
export interface RefsSnapshot {
  /** 全部链接定义（首现去重后，文档序） */
  links: LinkDefEntry[];
  /** 全部脚注定义（首现去重后，文档序） */
  footnotes: FootnoteDefEntry[];
  /** 脚注引用（首次出现顺序；未引用的定义不在此列，不进脚注列表） */
  footnoteRefs: FootnoteRefInfo[];
}

/** 空快照（主线程 STORE 初始 / 空文档落地用） */
export const EMPTY_REFS: RefsSnapshot = {
  links: [],
  footnotes: [],
  footnoteRefs: [],
};

/** handler 收集的中间条目（worker 内部；链接条目直接可作快照输出） */
export type RefsDefEntry =
  | { kind: "link"; entry: LinkDefEntry }
  | { kind: "footnote"; entry: FootnoteDefEntry };

/** 单次 toHast 转换的引用声明收集器：mdast 定义节点 → 条目
 *  （以节点对象为键；同一节点在本次转换内只收集一次，天然去重，
 *  跨转换的重复定义由快照构建的文档序首现规则裁决） */
export type RefsCollector = Map<MdastContent, RefsDefEntry>;

/** 引用基线（增量解析用；与 blocks 一一对齐，语义同 blockCounts：
 *  只重算被替换块，head/tail 按下标复用） */
export interface RefsBaseline {
  /** 每块内的定义条目（文档序内序） */
  defsByBlock: RefsDefEntry[][];
  /** 每块内的脚注引用 identifier 序列（文档序内序） */
  refSeqByBlock: string[][];
}

/** 读取 HAST 元素属性（兼容 sanitize 前后两种键名形态：
 *  handler 写入 "data-identifier"，sanitize 后规范化为 dataIdentifier） */
export function readRefProp(el: HastElement, name: string): string {
  const props = (el.properties ?? {}) as Record<string, unknown>;
  const camel = name.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());
  const v = props[name] ?? props[camel];
  return v == null ? "" : String(v);
}

/** 脚注定义内容 mini 管线：state.all 产物 →（含 raw 时）融合 → sanitize
 *  →（含 raw 时）img 归一化 → 剥 position → 图片上下文标注 → 任务列表
 *  前导空白剥离。收集内容不进主管线树（handler 返回 undefined），
 *  必须在此补齐等价处理，否则脚注内的 raw HTML 会被跳过且未经净化。 */
function processFootnoteContent(children: HastContent[]): HastContent[] {
  if (!children.length) return children;
  const root = { type: "root", children } as unknown as HastRoot;
  const hasRaw = children.some(treeHasRaw);
  let out = hasRaw ? (rehypeRaw(root as never) as HastRoot) : root;
  out = rehypeSanitize(sanitizeSchema)(out as never) as unknown as HastRoot;
  if (hasRaw) normalizeHtmlImages(out);
  for (const n of out.children as HastContent[]) stripHastPosition(n);
  annotateImageContext(out);
  stripTaskListLeadSpace(out);
  return out.children as HastContent[];
}

/** 深度遍历（文档序）收集定义节点条目与脚注引用出现
 *  （line 为调用方语义：全量传 0（mdast 行号即绝对行号），增量传 baseLine） */
export function walkRefs(
  children: MdastContent[],
  collector: RefsCollector,
  baseLine: number
): { defs: { entry: RefsDefEntry; line: number }[]; fnRefs: { identifier: string; line: number }[] } {
  const defs: { entry: RefsDefEntry; line: number }[] = [];
  const fnRefs: { identifier: string; line: number }[] = [];
  const visit = (node: MdastContent): void => {
    const n = node as unknown as {
      type: string;
      children?: MdastContent[];
      identifier?: string;
      position?: { start: { line: number } };
    };
    if (n.type === "definition" || n.type === "footnoteDefinition") {
      const entry = collector.get(node);
      const line = (n.position?.start.line ?? 1) + baseLine;
      if (entry) defs.push({ entry, line }); // handler 必已收集；防御性跳过
    } else if (n.type === "footnoteReference") {
      fnRefs.push({
        identifier: String(n.identifier ?? ""),
        line: (n.position?.start.line ?? 1) + baseLine,
      });
    }
    if (Array.isArray(n.children)) for (const c of n.children) visit(c);
  };
  for (const c of children) visit(c);
  return { defs, fnRefs };
}

/** 由基线构建快照（首现去重 + 引用顺序 / 次数统计） */
export function buildRefsSnapshot(baseline: RefsBaseline): RefsSnapshot {
  const links: LinkDefEntry[] = [];
  const footnotes: FootnoteDefEntry[] = [];
  const seenLink = new Set<string>();
  const seenFn = new Set<string>();
  for (const arr of baseline.defsByBlock) {
    for (const d of arr) {
      if (d.kind === "link") {
        if (seenLink.has(d.entry.identifier)) continue; // CommonMark：首个同名定义生效
        seenLink.add(d.entry.identifier);
        links.push(d.entry);
      } else {
        if (seenFn.has(d.entry.identifier)) continue; // GFM：首个同名脚注定义生效
        seenFn.add(d.entry.identifier);
        footnotes.push(d.entry);
      }
    }
  }
  const footnoteRefs: FootnoteRefInfo[] = [];
  const idx = new Map<string, number>();
  for (const arr of baseline.refSeqByBlock) {
    for (const ident of arr) {
      const i = idx.get(ident);
      if (i === undefined) {
        idx.set(ident, footnoteRefs.length);
        footnoteRefs.push({ identifier: ident, count: 1 });
      } else {
        footnoteRefs[i].count++;
      }
    }
  }
  return { links, footnotes, footnoteRefs };
}

/** 全量路径：mdast root + 块行界 → 引用基线（定义/引用按行归属到块） */
export function buildRefsBaselineFull(
  root: Root,
  blocks: PreviewBlock[],
  collector: RefsCollector
): RefsBaseline {
  const { defs, fnRefs } = walkRefs(root.children, collector, 0);
  const defsByBlock: RefsDefEntry[][] = blocks.map(() => []);
  for (const d of defs) {
    const j = blockIndexForLine(blocks, d.line);
    if (j >= 0) defsByBlock[j].push(d.entry);
  }
  const refSeqByBlock: string[][] = blocks.map(() => []);
  for (const r of fnRefs) {
    const j = blockIndexForLine(blocks, r.line);
    if (j >= 0) refSeqByBlock[j].push(r.identifier);
  }
  return { defsByBlock, refSeqByBlock };
}

/**
 * 未定义引用的字面回退（与 mdast-util-to-hast 默认 imageReference 行为一致）：
 * 全写 `![alt][id]`、收窄 `![alt][]`、缩写 `![alt]` 分别还原为对应源码文本。
 * （alt 兼容 null：mdast ImageReference.alt 可为 string | null | undefined）
 * 导出供 MarkdownImage 组件（STORE 渲染期解析失败的字面量回退）复用。
 */
export function revertReferenceText(node: Reference & { alt?: string | null }): string {
  let suffix = "]";
  if (node.referenceType === "collapsed") suffix += "[]";
  else if (node.referenceType === "full") suffix += `[${node.label || node.identifier}]`;
  return `![${node.alt ?? ""}${suffix}`;
}

/** 任意深度是否存在 raw 节点（raw HTML 可能嵌在列表/引用内，顶层检测会漏） */
function treeHasRaw(node: HastContent): boolean {
  if (node.type === "raw") return true;
  const kids = (node as { children?: HastContent[] }).children;
  return Array.isArray(kids) ? kids.some(treeHasRaw) : false;
}

function isMdlAnchor(node: HastContent): boolean {
  return (
    node.type === "comment" &&
    (node as { value: string }).value.startsWith(MDL)
  );
}

function annotateTableOrdinals(root: HastRoot): void {
  let ordinal = 0;
  const visit = (node: RootContent): void => {
    if (node.type === "comment") {
      if (isMdlAnchor(node)) ordinal = 0;
      return;
    }
    if (node.type !== "element") return;
    const el = node as HastElement;
    if (el.tagName === "table") {
      (el.properties ??= {})["data-table-ordinal"] = String(ordinal++);
      return;
    }
    for (const c of el.children) visit(c);
  };
  for (const c of root.children) visit(c);
}

/** 数学公式 → md-math 自定义元素（LaTeX 源码原样承载为唯一 text 子节点）。
 *  display="1" 为独立块（$$...$$），display="0" 为行内（$...$）；
 *  渲染由 MarkdownNode 分派 MarkdownMath 组件（MathJax SVG），查找彻底排除。
 *  经 state.patch 复制 position：$$ 块是顶层节点，锚注入依赖 position
 *  生成独立行号锚（独立成段/块，滚动同步 / 增量解析全通）。 */
function mdMathElement(
  state: MdastToHastState,
  node: Math | InlineMath,
  display: "1" | "0",
): HastContent {
  const el = {
    type: "element",
    tagName: "md-math",
    properties: { "data-display": display },
    children: [{ type: "text", value: node.value }],
  };
  state.patch(node, el);
  return el as unknown as HastContent;
}

function mdastToHastRaw(root: Root): RawResult {
  /* 引用声明收集器：definition / footnoteDefinition handler 在转换期间
     写入（walkRefs 按 mdast 节点对象取回），解析结束时 finalize 成快照 */
  const refsCollector: RefsCollector = new Map();
  const hast = toHast(root as never, {
    allowDangerousHtml: true,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handlers: {
      // 签名：handler(state, node, parent) —— 第一个参数是 state 上下文
      image: ((_state: never, node: Image) =>
        ({
          type: "element",
          tagName: "img",
          properties: {
            "data-src": rewriteImageSrc(node.url),
            "data-alt": node.alt ?? "",
          },
          children: [],
        }) as unknown as HastContent) as never,
      // 链接引用式图片（![alt][id] / ![alt][] / ![alt]）：不解析定义，
      // 产出携带引用信息的 img 标记，渲染层 MarkdownImage 从全局 STORE
      // 查找（修复 chunk 局部转换期间查不到 head/tail 定义而误回退字面量）；
      // 引用不可用 / 链接为空时由组件显示字面量
      imageReference: ((_state: never, node: ImageReference) =>
        ({
          type: "element",
          tagName: "img",
          properties: {
            "data-ref-identifier": node.identifier,
            "data-ref-label": node.label ?? node.identifier,
            "data-ref-type": node.referenceType,
            "data-alt": node.alt ?? "",
          },
          children: [],
        }) as unknown as HastContent) as never,
      // 链接引用（[text][id] / [text][] / [text]）：同上标记化（children =
      // 链接文本的行内内容），渲染层 MarkdownLinkRef 从 STORE 查找
      linkReference: ((state: MdastToHastState, node: LinkReference) =>
        ({
          type: "element",
          tagName: "md-link-ref",
          properties: {
            "data-identifier": node.identifier,
            "data-label": node.label ?? node.identifier,
            "data-ref-type": node.referenceType,
          },
          children: state.all(node),
        }) as unknown as HastContent) as never,
      // 数学公式（remark-math）：$$...$$ 独立块 / $...$ 行内 → md-math
      // 元素（LaTeX 源码原样承载，MarkdownMath 组件 MathJax SVG 自渲染；
      // $$ 块是顶层节点 → 自动获得行号锚，独立成段/块，滚动同步全通）
      math: ((state: MdastToHastState, node: Math) =>
        mdMathElement(state, node, "1")) as never,
      inlineMath: ((state: MdastToHastState, node: InlineMath) =>
        mdMathElement(state, node, "0")) as never,
      // 脚注引用（[^label]）：标记化（默认 handler 会产出 sup + 注册
      // footnoteOrder，进而触发 toHast 顶层 footer() 追加 section.footnotes
      // ——重写后不再注册，脚注列表完全由 STORE 驱动的组件渲染）
      footnoteReference: ((_state: never, node: FootnoteReference) =>
        ({
          type: "element",
          tagName: "md-footnote-ref",
          properties: {
            "data-identifier": node.identifier,
            "data-label": node.label ?? node.identifier,
          },
          children: [],
        }) as unknown as HastContent) as never,
      // 链接定义（[label]: url）：handler 期间收集进收集器（解析结束时
      // 全量更新 STORE），返回 undefined 保持原位不渲染 DOM 的既有语义
      definition: ((_state: never, node: Definition) => {
        if (!refsCollector.has(node)) {
          refsCollector.set(node, {
            kind: "link",
            entry: {
              identifier: node.identifier,
              label: node.label ?? node.identifier,
              url: node.url ?? "",
              title: node.title ?? null,
            },
          });
        }
        return undefined;
      }) as never,
      // 脚注定义（[^label]: 内容）：收集进收集器——内容经 state.all 转为
      // HAST（内层引用 / 图片标记自然生成，支持脚注嵌套），并补齐 raw
      // 融合 / sanitize / 上下文标注（收集内容不进主管线树，见
      // processFootnoteContent）；返回 undefined 不渲染 DOM，
      // 也不生成默认的 section.footnotes
      footnoteDefinition: ((state: MdastToHastState, node: FootnoteDefinition) => {
        if (!refsCollector.has(node)) {
          refsCollector.set(node, {
            kind: "footnote",
            entry: {
              identifier: node.identifier,
              label: node.label ?? node.identifier,
              children: processFootnoteContent(state.all(node)),
            },
          });
        }
        return undefined;
      }) as never,
    } as never,
  }) as HastRoot;
  /* 表格来源标记（Markdown vs raw HTML）：
   * - Markdown（GFM）表格在 toHast 产物上先打 data-md-table，再进入
   *   rehype-raw 融合 / sanitize。实测（hast-util-raw 9）融合保留既有元素的
   *   properties（img 的 data-src 同理），且 'data*' 在 sanitize 白名单，
   *   属性键会被规范化为 dataMdTable（消费方需兼容两种键名）；
   * - 融合后无该标记的 <table> 即 raw HTML 来源，补打 data-html-table。
   * 可编辑表格组件（EditableTable）按此标记决定反向更新时输出格式化后的
   * Markdown 源码还是 HTML RAW。 */
  markMarkdownTables(hast);
  const hasRaw = (hast.children as HastContent[]).some(treeHasRaw);
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
  // 无 raw HTML 时跳过 parse5 全树重解析（大文档主要成本），锚天然保留
  const result = hasRaw ? (rehypeRaw(anchored as never) as HastRoot) : anchored;
  // 标题锚点（GitHub 风格 slug id）：HAST 层执行（原因见 slugProcessor 注释）。
  // 放 sanitize 之前：id 在 sanitize 白名单（'*' 属性 + clobberPrefix ""）
  // 原样放行；rehype-slug 自身避让文档已有 id——脚注回链 id 安全，
  // raw HTML 书写的 <h2 id="custom"> 也不会被覆盖。
  slugProcessor.runSync(result as never);
  // rehype-sanitize 净化（XSS 白名单）。必须在 rehype-raw 融合之后——
  // 融合前 raw HTML 只是 text / raw 节点，净化形同虚设；
  // normalizeHtmlImages / annotateImageContext 在其后执行，
  // 其写入/迁移的属性无需进 schema。sanitize 重建整棵树（非 in-place），
  // 后续步骤全部改用其产物。
  const sanitized = rehypeSanitize(sanitizeSchema)(result as never) as unknown as HastRoot;
  // rehype-raw 融合后，HTML 语法书写的 <img>（含嵌在其他 HTML 标签内）带原生
  // src 属性——image/imageReference handler 只作用于 Markdown 语法的图片，
  // 管不到 raw 路径。这里把融合树中的 <img> 属性原地归一化（src → data-src
  // 经 ImgProxy 重写），与 Markdown 语法图片（img + data-src）在渲染层
  // MarkdownNode 统一映射为 MarkdownImage 组件（三态占位）。
  if (hasRaw) normalizeHtmlImages(sanitized);
  // 融合后仍无 data-md-table 标记的 <table> 即 raw HTML 来源（融合会原样
  // 保留 markdown 侧属性，见 markMarkdownTables 注释）→ 补打 html 来源标记
  markHtmlTables(sanitized);
  annotateTableOrdinals(sanitized);
  // 剥除 HAST position：渲染层只消费结构/文本，不读行号（行号在锚 comment 与
  // mdast root 上）；统一剥除后增量（局部转换、position 为 chunk 行号）与全量
  // （全文行号）的 HAST 结构完全一致，渲染层引用对比/快照测试不受干扰。
  for (const n of sanitized.children as HastContent[]) stripHastPosition(n);
  annotateImageContext(sanitized);
  stripTaskListLeadSpace(sanitized);
  return { hast: sanitized, hasRaw, refsCollector };
}

/** 递归剥除 HAST 节点 position（in-place；含 children 深层） */
function stripHastPosition(node: HastContent): void {
  const n = node as { position?: unknown };
  delete n.position;
  const kids = (node as { children?: HastContent[] }).children;
  if (Array.isArray(kids)) for (const k of kids) stripHastPosition(k);
}

/* ---------------- 表格来源标记（Markdown vs raw HTML） ---------------- */

/** mdast → hast 产物上的 GFM 表格标记（sanitize 后属性键规范化为 dataMdTable） */
const MD_TABLE_FLAG = "data-md-table";
/** raw HTML 表格标记（融合 + sanitize 之后补打） */
const HTML_TABLE_FLAG = "data-html-table";

/** 读取元素上的表格来源标记（兼容 sanitize 前后的两种属性键形态） */
function hasTableFlag(el: HastElement, flag: string): boolean {
  const props = (el.properties ?? {}) as Record<string, unknown>;
  const camel = flag.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());
  return Boolean(props[flag] ?? props[camel]);
}

/** 递归标记 toHast 产物中的 GFM 表格（in-place；融合前执行以幸存 rehype-raw） */
function markMarkdownTables(node: HastRoot | HastContent): void {
  const kids = (node as { children?: HastContent[] }).children;
  if (!Array.isArray(kids)) return;
  for (const c of kids) {
    if (c.type === "element") {
      const el = c as HastElement;
      if (el.tagName === "table") {
        (el.properties ??= {})[MD_TABLE_FLAG] = "1";
      }
      markMarkdownTables(el);
    }
  }
}

/** 递归为融合后无 markdown 标记的 <table> 补打 raw HTML 来源标记（in-place） */
function markHtmlTables(node: HastRoot | HastContent): void {
  const kids = (node as { children?: HastContent[] }).children;
  if (!Array.isArray(kids)) return;
  for (const c of kids) {
    if (c.type === "element") {
      const el = c as HastElement;
      if (el.tagName === "table" && !hasTableFlag(el, MD_TABLE_FLAG)) {
        (el.properties ??= {})[HTML_TABLE_FLAG] = "1";
      }
      markHtmlTables(el);
    }
  }
}

/* ---------------- HTML 语法图片归一化（rehype-raw 融合后） ---------------- */

/**
 * 把融合树中的 <img>（HTML 语法书写的图片，含嵌在其他 HTML 标签内）属性
 * 原地归一化为 img + data-src / data-alt（不再使用 md-image 中间标签，
 * 渲染层 MarkdownNode 把 img 统一映射为 MarkdownImage 组件）。
 * 仅处理带 src 属性的 img（raw HTML 书写的图片）——image / imageReference
 * handler 产物无 src（直接式已带 data-src、引用式携带 data-ref-*），
 * 必须原样保留，否则引用式标记会被擦除成普通空图。
 * 仅迁移 src / alt（组件消费的属性）；width/height/style 等由 HTML 语法
 * 直接控制的属性不迁移——与块级/行内分派语义（annotateImageContext）保持一致。
 */
function normalizeHtmlImages(node: HastRoot | HastContent): void {
  const kids = (node as { children?: HastContent[] }).children;
  if (!Array.isArray(kids)) return;
  for (const c of kids) {
    if (c.type === "element" && (c as HastElement).tagName === "img") {
      const el = c as HastElement;
      const props = (el.properties ?? {}) as Record<string, unknown>;
      if (props.src != null) {
        el.properties = {
          "data-src": rewriteImageSrc(String(props.src)),
          "data-alt": String(props.alt ?? ""),
        };
      }
    }
    normalizeHtmlImages(c);
  }
}

/* ---------------- 图片上下文标注（块级 vs 行内） ---------------- */

/** 是否图片元素（image / imageReference handler 与 raw 路径归一化的统一产物；
 *  树中所有 img 均由管线管理，渲染层统一映射 MarkdownImage） */
const isMdImageEl = (n: HastContent): boolean =>
  n.type === "element" && (n as { tagName?: string }).tagName === "img";

/** 是否空白 text 节点 */
const isBlankText = (n: HastContent): boolean =>
  n.type === "text" && !((n as { value?: string }).value ?? "").trim();

/**
 * 独立图片段判定：p 的 children 全部为 img / 空白 text /
 * 「内部同样只含 img+空白的 <a>」，且**恰好一张图**。
 * - [![img](src)](url) 链接包裹独自成块也算块级图片；
 * - 一行多图不算块级：块级占位 width:100% 会让多图垂直堆叠，
 *   行内模式（原尺寸）才符合并排的视觉预期 → 归入行内。
 */
export function isImageOnlyParagraph(p: HastElement): boolean {
  let imageCount = 0;
  for (const c of p.children) {
    if (isBlankText(c)) continue;
    if (isMdImageEl(c)) {
      imageCount++;
      continue;
    }
    if (c.type === "element" && (c as HastElement).tagName === "a") {
      let inner = 0;
      for (const g of (c as HastElement).children) {
        if (isBlankText(g)) continue;
        if (!isMdImageEl(g)) return false;
        inner++;
      }
      if (inner !== 1) return false;
      imageCount++;
      continue;
    }
    return false;
  }
  return imageCount === 1;
}

/**
 * 给每个图片元素标注渲染上下文：块级（独立成段，含 <a> 包裹）不标注，
 * 行内（与文字混排 / 标题 / 表格等一切其他场景）标 data-inline="1"。
 * 渲染层与 CSS 按该标注分派两种占位/尺寸实现。
 */
function annotateImageContext(root: HastRoot): void {
  const visit = (el: HastElement, parent: HastElement | null, grand: HastElement | null): void => {
    if (isMdImageEl(el)) {
      // 块级判定以「最近的段落祖先」为准：<a> 包裹时上溯一层
      const p = parent && parent.tagName === "a" ? grand : parent;
      const blockLevel = p !== null && p.tagName === "p" && isImageOnlyParagraph(p);
      if (!blockLevel) (el.properties ??= {})["data-inline"] = "1";
      return;
    }
    for (const c of el.children) {
      if (c.type === "element") visit(c as HastElement, el, parent);
    }
  };
  for (const c of root.children as HastContent[]) {
    if (c.type === "element") visit(c as HastElement, null, null);
  }
}

/**
 * 剥离 GFM 任务列表项中紧跟 checkbox 的 text 节点前导空白。
 *
 * 【为什么需要】`- [ ] foo` 的 `[ ]` 是段落内 inline 标记，mdast-util-to-hast
 * 只把 `<input type="checkbox">` unshift 到 children 前、不改写其后 text，
 * 文本是 " foo"。`white-space: pre-wrap` 下会真实占宽，比普通列表项多缩进
 * 一个空格，与原生列表视觉不一致。
 *
 * 【两路结构】
 * - tight list：li.children = [input, text, ...]
 * - loose list：li.children = [p(children=[input, text, ...]), p?, ...]
 * GFM 保证含 checkbox 的段落是 li 的第一个块，故：
 *   先查 li 直接子级 input（tight），找不到再下钻**一层**到第一个 p（loose）。
 *   只下钻一层，嵌套任务子列表的 input 在其自己的 li 里，不会被误剥。
 *
 * 【不变量】只改 text.value、不增删节点 → 「锚数 === 块数」、
 * 段/块一一对应、增量 head/tail 引用复用全部不受影响。幂等：已剥的
 * 值再剥无变化，全量/局部 chunk/重复执行均安全。
 */
function stripTaskListLeadSpace(root: HastRoot): void {
  const isCheckbox = (c: HastContent): boolean =>
    c.type === "element" &&
    (c as HastElement).tagName === "input" &&
    (c as HastElement).properties?.type === "checkbox";

  /** 返回 checkbox 所在的 children 容器与下标（tight 直挂 / loose 下钻一层 p） */
  const locate = (
    li: HastElement
  ): { container: HastContent[]; index: number } | null => {
    const direct = li.children.findIndex(isCheckbox);
    if (direct >= 0) return { container: li.children, index: direct };
    for (const c of li.children) {
      if (c.type !== "element" || (c as HastElement).tagName !== "p") continue;
      const p = c as HastElement;
      const idx = p.children.findIndex(isCheckbox);
      if (idx >= 0) return { container: p.children, index: idx };
      break; // GFM 保证含 checkbox 的是第一个段落，其余 p 不再看
    }
    return null;
  };

  const visit = (node: HastContent): void => {
    if (node.type === "element" && (node as HastElement).tagName === "li") {
      const el = node as HastElement;
      const cls = el.properties?.className;
      const isTask = Array.isArray(cls)
        ? cls.includes("task-list-item")
        : cls === "task-list-item";
      if (isTask) {
        const found = locate(el);
        const next = found ? found.container[found.index + 1] : undefined;
        if (next?.type === "text") {
          const t = next as { value: string };
          t.value = t.value.replace(/^[ \t]+/, "");
        }
      }
    }
    const kids = (node as { children?: HastContent[] }).children;
    if (Array.isArray(kids)) for (const c of kids) visit(c);
  };
  for (const c of root.children as HastContent[]) visit(c);
}

/** mdast 根 → HAST 根（含行号锚；raw HTML 已融合） */
export function rootToHast(root: Root): HastRoot {
  return mdastToHastRaw(root).hast;
}

/** mdast 根 → 转换产物（HAST + 引用声明收集器）。
 *  例行重建 worker 用它一次性完成转换与收集（buildBlocks 的二次转换
 *  属历史低效，重建路径在此合并为单次）。 */
export function convertRoot(root: Root): RawResult {
  return mdastToHastRaw(root);
}

/** Markdown 源码 → HAST 根（管线唯一入口：parse → toHast → raw 融合） */
export function compileMarkdown(src: string): HastRoot {
  return rootToHast(parseMarkdown(src));
}

/** hast 元素/文本节点类型名（预览块 type 仅供展示/调试） */
function hastType(node: HastContent): string {
  if (node.type === "element") return (node as { tagName?: string }).tagName ?? "element";
  return node.type;
}

/**
 * HAST 根 → 渲染段列表（MarkdownSegment 逐段渲染、PreviewPane 虚拟滚动）。
 * 每个锚 comment 开启新段，段收集锚后的全部内容节点——
 * 段数与 blocksFromHast 的块数一一对应（滚动同步依赖该不变量）。
 */
export interface HastSegment {
  /** 段首节点类型（md-item 的 data-btype） */
  type: string;
  nodes: HastContent[];
}

export function splitSegments(hast: HastRoot): HastSegment[] {
  const segs: HastSegment[] = [];
  let cur: HastSegment | null = null;
  for (const n of hast.children as HastContent[]) {
    if (isMdlAnchor(n)) {
      cur = null; // 新锚：下一段由其后的首个内容节点开启
      continue;
    }
    if (n.type === "text" && !(n as { value?: string }).value?.trim()) continue;
    if (!cur) {
      cur = { type: hastType(n), nodes: [n] };
      segs.push(cur);
    } else {
      cur.nodes.push(n);
    }
  }
  return segs;
}

/**
 * HAST 顶层节点 → 预览块（行号来自顶层锚点 comment；区间无缝覆盖全部源行，
 * 满足增量解析对块边界的连续性要求）。
 * 块只承载行界/类型映射，不再生成 HTML（渲染交给 Svelte 组件树）。
 * @param claimLead 首块是否认领锚前空行：全量路径（文档首块）为 true，
 *   与 emit(a-1) 的「空行归上一块」语义在文档开头处衔接；增量局部 chunk
 *   且存在上一块（head）时必须为 false——空行改由 head 末块吸收，
 *   否则首块 startLine 回拉到 chunk 起点，块行界相对真实锚点永久前移
 *   （行数变化型编辑后无法自愈，且逐次放大）。
 */
export function blocksFromHast(
  hast: HastRoot,
  totalLines: number,
  baseLine = 0,
  claimLead = true
): { blocks: PreviewBlock[]; unmapped: boolean } {
  const top = hast.children as HastContent[];
  // 锚跟随其后的首个内容节点；行号区间 = 本锚 start .. 下一锚 start - 1（无缝覆盖）
  const blocks: PreviewBlock[] = [];
  /* 上一 emitted 块的（chunk 内）endLine：块起点若与它有间隙（锚前空行等），
     起点向前扩到 lastEnd+1。增量路径的局部 chunk 首块由此认领锚前的空行——
     全量路径这些行由上一块的 emit(a-1) 吸收，局部 chunk 没有上一块，必须自补 */
  let lastEnd = 0;
  let pending: { start: number; end: number } | null = null;
  let pendingNode: HastContent | null = null;
  /* true = 存在未挂上锚点的节点 → 块边界不可靠，调用方应保守全量 */
  let unmapped = false;

  const emit = (endLine: number): void => {
    if (!pending || !pendingNode) return;
    blocks.push({
      index: blocks.length,
      type: hastType(pendingNode),
      /* 首块且不允许认领前导空行（增量 chunk 且存在上一块）时，
         startLine 取锚自身行；其余场景与全量一致（min 回拉吞间隙：
         首块吃文档前导空行，后续块 lastEnd+1 恒等于锚行，min 为空操作） */
      startLine:
        (blocks.length === 0 && !claimLead
          ? pending.start
          : Math.min(pending.start, lastEnd + 1)) + baseLine,
      endLine: endLine + baseLine,
    });
    lastEnd = endLine;
    pending = null;
    pendingNode = null;
  };

  for (const n of top) {
    if (isMdlAnchor(n)) {
      // 新锚：结算上一块（区间到本锚 start - 1），挂新锚
      const [a, b] = (n as { value: string }).value.slice(MDL.length).split(":").map(Number);
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      if (pending) emit(a - 1);
      pending = { start: a, end: b };
      pendingNode = null;
      continue;
    }
    if (n.type === "text" && !(n as { value?: string }).value?.trim()) continue;
    if (pendingNode) continue; // 同一锚下的多余节点（罕见）：保守跳过
    if (!pending) {
      unmapped = true; // 无锚可挂（不应发生）：块边界不可靠
      continue;
    }
    pendingNode = n;
  }
  if (pending) emit(pending.end);
  /* 尾部未映射行（文档末尾空行等）：并入最后一块，保证行界无缝覆盖到 chunk 末行。
     与 lastEnd（首部认领）成对：锚区间之外的行不允许悬空 */
  if (blocks.length && lastEnd < totalLines) {
    blocks[blocks.length - 1].endLine += totalLines - lastEnd;
  }
  return { blocks, unmapped };
}

export function buildBlocks(root: Root, src: string): PreviewBlock[] {
  /* 行数必须与锚点行号同语义（remark 把 \r\n/\r/\n 都计为换行，见
     splitLines）：用 split("\n") 会在含孤立 \r 的文档上少计行数 →
     blocksCoverDoc 恒失败 → idle 自愈每 10s 重复一次全量解析 */
  return blocksFromHast(rootToHast(root), splitLines(src).length).blocks;
}

function textOf(node: PhrasingContent | MdastContent | null | undefined): string {
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

/* ---------------- 增量解析：行级 diff → 仅重解析受影响的顶层块 ----------------
 *
 * 全量 parse 在大文档上每次按键都有可感延迟。这里做块级增量：
 * 1. 行级公共前缀/后缀 diff 定位变化行区间；
 * 2. 映射到旧的顶层块区间 [i0, i1]，并按容器延续规则（列表/引用/表格/围栏）
 *    向外扩展，代码围栏未闭合时扩展到开启行/文末；
 * 3. 只对该区间的源码做局部 parse，拼接出新 blocks / root（行号平移修正）与 HAST；
 * 4. HAST 拼接复用 head/tail 段的节点引用（仅锚 comment 重建平移）——
 *    worker 回传段级补丁后，主线程未变段的对象引用保持稳定 →
 *    MarkdownNode 以节点引用为 props，引用不变 → Svelte 跳过该子树，
 *    只有真正变化的块被重渲染（增量渲染）。
 * 兜底：连续增量达到阈值且距上次全量超过时间闸门时，或 worker idle 自愈校验
 * 失败时，强制全量解析，防止启发式误差累积。
 */

export interface IncrementalParseState {
  src: string;
  root: Root | null;
  /** 上一轮 HAST 根（增量拼接复用 head/tail 节点引用） */
  hast: HastRoot | null;
  blocks: PreviewBlock[];
  /** 连续增量次数：达到阈值（SELF_HEAL_EVERY）且距上次全量超过
   *  SELF_HEAL_MIN_INTERVAL_MS 时强制全量防启发式误差累积；
   *  可选字段，旧调用方不传也能跑（按 0 处理） */
  incrementalCount?: number;
  /** 上次全量重建的时刻（ms）；与阈值共同决定例行全量时机（可选，0 = 从未） */
  lastFullAt?: number;
  /** 引用基线（与 blocks 一一对齐；可选：缺失时增量路径保守走全量，
   *  由设置本字段的调用方保证稳态恒有值） */
  refsBaseline?: RefsBaseline | null;
}

/** 增量结果的段级补丁区间（全量结果不携带）：主线程按此 splice 段列表 */
export interface SegmentPatchRange {
  /** 被替换区间在段列表中的起始下标 */
  segStart: number;
  /** 被替换的旧段数（含） */
  segRemoved: number;
  /** 替换后的新段数 */
  segAdded: number;
}

export interface IncrementalParseResult {
  root: Root;
  /** HAST 根（全量 = rootToHast；增量 = head/tail 引用复用 + 局部转换拼接） */
  hast: HastRoot;
  blocks: PreviewBlock[];
  full: boolean;
  /** 连续增量次数（调用方应存回 IncrementalParseState.incrementalCount；全量后归零） */
  incrementalCount: number;
  /** 全量发生时刻（调用方应存回 IncrementalParseState.lastFullAt） */
  lastFullAt: number;
  /** 段级补丁区间（仅增量结果有值；全量由调用方整体重建段列表） */
  patch?: SegmentPatchRange;
  /** 引用声明快照（解析结束全量产出：定义 first-wins 去重 + 首现引用顺序）；
   *  随解析结果回传主线程，原子更新全局 STORE */
  refs: RefsSnapshot;
  /** 引用基线（调用方应存回 IncrementalParseState.refsBaseline；与 blocks 对齐） */
  refsBaseline: RefsBaseline;
}

/** 连续增量 N 次后向重建 worker 请求周期性全量（阈值唯一归属点） */
export const SELF_HEAL_EVERY = 25;

/** 可能与前一顶层块延续成同一容器的行首特征 */
const CONT_RE = /^\s*(?:[-*+]|\d{1,9}[.)]|>|(?:```+|~~~+))\s*/;
/** 围栏标记行：捕获标记与行内剩余部分（剩余部分用于闭合判定） */
const FENCE_RE = /^\s{0,3}(```+|~~~+)(.*)$/;

/** 第一个 endLine >= line 的块下标（blocks 按 startLine 升序；找不到 = length） */
function firstBlockEndingAtOrAfter(blocks: PreviewBlock[], line: number): number {
  let lo = 0;
  let hi = blocks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (blocks[mid].endLine < line) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 最后一个 startLine <= line 的块下标（找不到 = -1） */
function lastBlockStartingAtOrBefore(blocks: PreviewBlock[], line: number): number {
  let lo = -1;
  let hi = blocks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (blocks[mid].startLine <= line) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** 递归收集 mdast 树中全部脚注定义 identifier（含嵌套在容器内的定义）。
 *  用途：增量局部 chunk 解析前注入桩定义——chunk 通常不含文末定义区，
 *  而 mdast-util-gfm-footnote 在 parse 阶段就会把未定义的 [^x] 回退为
 *  字面文本，导致局部 chunk 丢失 footnoteReference 节点（引用变字面量、
 *  增量 refs 少项）。桩只需 identifier 存在，内容无关。 */
function collectFootnoteIds(nodes: MdastContent[], out: Set<string>): void {
  for (const n of nodes) {
    const node = n as {
      type: string;
      identifier?: string;
      children?: MdastContent[];
    };
    if (node.type === "footnoteDefinition" && node.identifier) {
      out.add(node.identifier);
    }
    if (Array.isArray(node.children)) collectFootnoteIds(node.children, out);
  }
}

/** 递归收集 mdast 树中全部链接定义 identifier（含嵌套容器内的定义） */
function collectLinkDefIds(nodes: MdastContent[], out: Set<string>): void {
  for (const n of nodes) {
    const node = n as {
      type: string;
      identifier?: string;
      children?: MdastContent[];
    };
    if (node.type === "definition" && node.identifier) {
      out.add(node.identifier);
    }
    if (Array.isArray(node.children)) collectLinkDefIds(node.children, out);
  }
}

/**
 * lines[0..end) 的未闭合围栏 → 返回开启行（1-based）或 -1。
 * 按 CommonMark 判定闭合：同字符、长度不小于开启标记、且不得携带
 * info string（`​```ini` 是开启行而非闭合行）。此前把任何 FENCE_RE
 * 命中行都当开/关切换，`​```ini` 会被误判为闭合行 → 围栏状态错乱 →
 * chunk 起点落入围栏内部，局部解析与全量结构性分叉（块行界漂移，
 * 补丁区间错位传导到段列表）。
 */
function openFenceLine(lines: string[], end: number): number {
  let openLine = -1;
  let fence = "";
  let fenceLen = 0;
  for (let i = 0; i < end && i < lines.length; i++) {
    const m = lines[i].match(FENCE_RE);
    if (!m) continue;
    const marker = m[1];
    const rest = m[2] ?? "";
    if (openLine === -1) {
      // 开启行：反引号围栏的 info string 不得含反引号（否则是段落文本）
      if (marker[0] === "`" && rest.includes("`")) continue;
      openLine = i + 1;
      fence = marker[0];
      fenceLen = marker.length;
    } else if (
      marker[0] === fence &&
      marker.length >= fenceLen &&
      rest.trim() === ""
    ) {
      // 闭合行：仅同字符 + 长度足够 + 标记后只允许空白
      openLine = -1;
      fence = "";
      fenceLen = 0;
    }
  }
  return openLine;
}

function parseRange(
  src: string,
  lines: string[],
  fromLine: number,
  toLine: number,
  baseLine: number,
  claimLead = true,
  /** 脚注定义桩（"\n\n" 分隔的 `[^id]:` 列表）：让局部 chunk 内的 [^id]
   *  在 parse 阶段能匹配到定义、产出 footnoteReference 节点。桩节点在
   *  parse 后按行号过滤，不进入 children / refsCollector / 拼接基线。 */
  footnoteStubs = ""
): {
  children: MdastContent[];
  hast: HastRoot;
  blocks: PreviewBlock[] | null;
  /** 局部转换的引用声明收集器（键 = local mdast 节点对象） */
  refsCollector: RefsCollector;
} {
  const chunkLines = toLine - fromLine + 1;
  const chunk =
    lines.slice(fromLine - 1, toLine).join("\n") +
    (footnoteStubs ? "\n\n" + footnoteStubs : "");
  // 与 parseMarkdown 同链路：runSync 执行 remark 转换（rehype-slug 注入标题 id）。
  // chunk 源码显式传给 run：chunk 内 position.offset 与之一致，
  // 公式守卫按 offset 切原文判定（见 stripSpacedInlineMath）。
  const root = processor.runSync(processor.parse(chunk), chunk) as unknown as Root;
  // 过滤桩定义：桩拼在 chunk 之后 → position.start.line > chunkLines；
  // chunk 内真实定义（编辑发生在定义区时）行号 ≤ chunkLines，保留。
  // 注意：必须用过滤后的 children 构建 HAST——否则桩会进 refsCollector
  //（footnoteDefinition handler 收集）、进 walkRefs、进下一轮 prev.root。
  const realChildren = root.children.filter(
    (n) => !n.position || n.position.start.line <= chunkLines
  );
  const parsed = mdastToHastRaw({ ...root, children: realChildren });
  // 局部 chunk 含 raw HTML（rehype-raw 融合）时块边界可能跨越区间外 → 保守全量
  // totalLines 用原始 chunk 行数（桩不产锚，不参与块行界）
  const { blocks, unmapped } = parsed.hasRaw
    ? { blocks: null as PreviewBlock[] | null, unmapped: false }
    : blocksFromHast(parsed.hast, chunkLines, baseLine, claimLead);
  return {
    children: realChildren,
    hast: parsed.hast,
    blocks: unmapped || !blocks ? null : blocks,
    refsCollector: parsed.refsCollector,
  };
}

export function buildBlocksIncremental(
  prev: IncrementalParseState,
  nextSrc: string,
  forceFull: boolean
): IncrementalParseResult {
  const runFull = (): IncrementalParseResult => {
    const root = parseMarkdown(nextSrc);
    const conv = convertRoot(root);
    const blocks = blocksFromHast(conv.hast, splitLines(nextSrc).length).blocks;
    const refsBaseline = buildRefsBaselineFull(root, blocks, conv.refsCollector);
    return {
      root,
      hast: conv.hast,
      blocks,
      full: true,
      incrementalCount: 0,
      lastFullAt: Date.now(),
      /* 全量结果不走补丁：主线程收到 full 标记后整体重建段列表 */
      patch: { segStart: 0, segRemoved: 0, segAdded: 0 },
      refs: buildRefsSnapshot(refsBaseline),
      refsBaseline,
    };
  };

  const incCount = prev.incrementalCount ?? 0;
  if (
    forceFull ||
    !prev.root ||
    !prev.src ||
    prev.blocks.length === 0 ||
    /* 引用基线缺失（旧调用方 / 状态归零后）→ head/tail 引用条目无法复用，
       保守全量重建（稳态由设置 refsBaseline 的调用方保证恒有值） */
    !prev.refsBaseline
  ) {
    return runFull();
  }
  const prevBlocks = prev.blocks;

  // 行级公共前缀/后缀（行切分与锚点行号同语义，见 splitLines：
  // 含孤立 \r 的文档若按 split("\n") 切行，diff 区间与块行界错位）
  const prevLines = splitLines(prev.src);
  const nextLines = splitLines(nextSrc);
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

  // 变化区间 → 相交旧块区间 [i0, i1]（可为空：i0 = i1 + 1）；块行界升序 → 二分
  let i0 = firstBlockEndingAtOrAfter(prevBlocks, prevChgStart);
  let i1 = lastBlockStartingAtOrBefore(prevBlocks, prevChgEnd);

  // ---- 重解析区间（新文档行号）：锚定在未受影响块的边界上 ----
  // 起点：i0-1 块的末行 + 1（该行 < prevChgStart ≤ p+1，行号不变）
  let nextStart = i0 === 0 ? 1 : prevBlocks[i0 - 1].endLine + 1;
  // 终点：i1+1 块的首行 - 1（该行 > prevChgEnd，需 +delta 平移）
  let nextEnd =
    i1 === prevBlocks.length - 1
      ? nextLines.length
      : prevBlocks[i1 + 1].startLine + delta - 1;

  // 容器延续扩展：列表/引用/表格/围栏跨越块边界时，受影响范围向外扩；
  // 段落延续扩展：chunk 边界两侧相邻行均非空（无空行分隔）时同样外扩——
  // 否则纯插入行会被局部 parse 成独立段落，与全量 parse 的 lazy continuation
  // 语义（无空行的相邻行归属同一段落）不一致。
  const headContinues = (): boolean => {
    const firstChanged = nextLines[nextStart - 1] ?? "";
    const prevTail =
      i0 > 0 ? prevLines[Math.min(prevBlocks[i0 - 1].endLine, prevLines.length) - 1] : "";
    return (
      CONT_RE.test(firstChanged) ||
      CONT_RE.test(prevTail) ||
      (firstChanged.trim() !== "" && prevTail.trim() !== "")
    );
  };
  const tailContinues = (): boolean => {
    const lastChanged = nextLines[nextEnd - 1] ?? "";
    const nextHead =
      i1 + 1 < prevBlocks.length && prevBlocks[i1 + 1].startLine + delta - 1 < nextLines.length
        ? nextLines[prevBlocks[i1 + 1].startLine + delta - 1]
        : "";
    return (
      CONT_RE.test(lastChanged) ||
      CONT_RE.test(nextHead) ||
      (lastChanged.trim() !== "" && nextHead.trim() !== "")
    );
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
      i0 = firstBlockEndingAtOrAfter(prevBlocks, nextStart);
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
  // 脚注定义桩：从上一轮 mdast root 收集全部 identifier（稳态下即全文档
  // 定义全集——增量拼接的 root 保留 head + local + tail 全部定义节点）。
  // 拼接后 chunk 内的 [^id] 在 parse 阶段即可匹配定义，不会回退为字面文本；
  // 定义在 head/tail 区域时增量基线拼接照常复用，桩仅服务于本次 chunk 解析。
  const fnIds = new Set<string>();
  collectFootnoteIds(prev.root.children, fnIds);
  const linkIds = new Set<string>();
  collectLinkDefIds(prev.root.children, linkIds);
  const stubs: string[] = [];
  for (const id of fnIds) stubs.push(`[^${id}]:`);
  for (const id of linkIds) stubs.push(`[${id}]: /`);
  const defStubs = stubs.join("\n\n");
  const local = parseRange(
    nextSrc, nextLines, nextStart, nextEnd, baseLine, i0 === 0, defStubs
  );
  if (!local.blocks) return runFull(); // 局部含 raw 融合，无法可靠映射 → 全量

  // P0 不变量：绝不原地改共享块对象——prev.blocks 可能被主线程滚动同步 /
  // 大纲 / 上一轮 HAST 拼接引用，原地改写会让旧快照行号异步漂移。
  // headBlocks / tailBlocks 元素一律先克隆再改。
  const headBlocks = prev.blocks.slice(0, i0).map((b) => ({ ...b }));
  // tail 块整体 +delta 在克隆时完成（原循环删除）
  const tailBlocks = prev.blocks.slice(i1 + 1).map((b) => ({
    ...b,
    startLine: b.startLine + delta,
    endLine: b.endLine + delta,
  }));

  if (local.blocks.length > 0 && headBlocks.length > 0) {
    headBlocks[headBlocks.length - 1].endLine = local.blocks[0].startLine - 1;
  }

  const blocks: PreviewBlock[] = [...headBlocks, ...local.blocks, ...tailBlocks];
  for (let i = 0; i < blocks.length; i++) {
    blocks[i].index = i; // 克隆对象上的赋值，安全
  }
  // 原 for (const b of tailBlocks) { b.startLine += delta; ... } 已删除
  if (local.blocks.length === 0) {
    /* 局部区间无锚（纯空行/空 chunk）：不产块，但区间 [nextStart..nextEnd] 的行
       必须有人认领——并入相邻复用块，否则 head/tail 间出现行界空洞。
       注意：此时 headBlocks / tailBlocks 已是克隆，赋值安全；
       nextEnd / nextStart 均为新文档行号，与克隆块语义一致 */
    if (headBlocks.length > 0) {
      headBlocks[headBlocks.length - 1].endLine = nextEnd;
    } else if (tailBlocks.length > 0) {
      tailBlocks[0].startLine = nextStart;
    }
  }

  /* ---- HAST 拼接（head/tail 段节点引用复用 → 渲染层增量更新）----
     前提：prev.hast 顶层为「锚 comment + 内容节点」结构且锚数 === 块数；
     锚 comment 重建（行号平移），内容节点引用原样保留。
     锚定位只依赖锚出现序（不依赖每锚一节点：段内多节点随段整体复用）。 */
  const prevHast = prev.hast;
  const anchorCount = (children: HastContent[]): number => {
    let n = 0;
    for (const c of children) if (isMdlAnchor(c)) n++;
    return n;
  };
  const nthAnchorIndex = (children: HastContent[], nth: number): number => {
    let n = 0;
    for (let k = 0; k < children.length; k++) {
      if (isMdlAnchor(children[k])) {
        if (n === nth) return k;
        n++;
      }
    }
    return -1;
  };
  if (!prevHast || anchorCount(prevHast.children as HastContent[]) !== prevBlocks.length) {
    return runFull(); // 结构漂移：保守全量重建引用
  }
  if (anchorCount(local.hast.children as HastContent[]) !== local.blocks.length) {
    return runFull();
  }

  /* ---- 引用基线拼接（defsByBlock / refSeqByBlock，与 blocks 一一对齐）----
     head/tail 按下标复用 prev 基线条目（与 blockCounts 同模式，未变块
     不重扫）；局部定义/引用按行归属到合并块（块无缝覆盖全文的既有不变量
     ——定义不产 hast、无锚，所在行本就由相邻块吸收，按行归属与其对齐）：
     - 局部条目落点在 head 边界块（首锚前的定义行）：追加在复用条目之后
       （局部行 > head 行，文档序正确）；
     - 落点在 tail 边界块（局部无块时行由 tail 首块认领）：前插（局部行
       < tail 原内容行）；
     - 落点在局部槽位：仅由局部条目填充（新块）。
     快照（首现去重 / 引用顺序）由 buildRefsSnapshot 统一裁决，此处只管
     基线的文档序拼接。 */
  const localRefs = walkRefs(local.children, local.refsCollector, baseLine);
  const localDefLists = new Map<number, RefsDefEntry[]>();
  const pushLocalDef = (j: number, e: RefsDefEntry): void => {
    const arr = localDefLists.get(j);
    if (arr) arr.push(e);
    else localDefLists.set(j, [e]);
  };
  const localRefLists = new Map<number, string[]>();
  const pushLocalRef = (j: number, identifier: string): void => {
    const arr = localRefLists.get(j);
    if (arr) arr.push(identifier);
    else localRefLists.set(j, [identifier]);
  };
  for (const d of localRefs.defs) {
    const j = blockIndexForLine(blocks, d.line);
    if (j >= 0) pushLocalDef(j, d.entry);
  }
  for (const r of localRefs.fnRefs) {
    const j = blockIndexForLine(blocks, r.line);
    if (j >= 0) pushLocalRef(j, r.identifier);
  }
  const prevDefs = prev.refsBaseline.defsByBlock;
  const prevRefSeq = prev.refsBaseline.refSeqByBlock;
  const localN = local.blocks.length;
  const removedN = i1 - i0 + 1;
  const defsByBlock: RefsDefEntry[][] = [];
  const refSeqByBlock: string[][] = [];
  for (let j = 0; j < blocks.length; j++) {
    let dArr: RefsDefEntry[] | undefined;
    let rArr: string[] | undefined;
    if (j < i0) {
      dArr = prevDefs[j];
      rArr = prevRefSeq[j];
    } else if (j >= i0 + localN) {
      const pj = j - localN + removedN;
      dArr = prevDefs[pj];
      rArr = prevRefSeq[pj];
    }
    const dl = localDefLists.get(j);
    const rl = localRefLists.get(j);
    if (dl) dArr = dArr ? (j < i0 ? [...dArr, ...dl] : [...dl, ...dArr]) : dl;
    if (rl) rArr = rArr ? (j < i0 ? [...rArr, ...rl] : [...rl, ...rArr]) : rl;
    defsByBlock.push(dArr ?? []);
    refSeqByBlock.push(rArr ?? []);
  }
  const refsBaseline: RefsBaseline = { defsByBlock, refSeqByBlock };
  const shiftAnchor = (c: HastContent, by: number): HastContent => {
    const [a, b] = (c as { value: string }).value.slice(MDL.length).split(":").map(Number);
    return { type: "comment", value: `${MDL}${a + by}:${b + by}` } as HastContent;
  };
  const headEnd = i0 < prevBlocks.length ? nthAnchorIndex(prevHast.children as HastContent[], i0) : -1;
  const tailStart =
    i1 + 1 < prevBlocks.length ? nthAnchorIndex(prevHast.children as HastContent[], i1 + 1) : -1;
  const headChildren = headEnd >= 0 ? prevHast.children.slice(0, headEnd) : prevHast.children;
  const tailChildren = tailStart >= 0 ? prevHast.children.slice(tailStart) : [];
  /* 段间分隔规范化：toHast 会在顶层节点之间输出 "\n" 分隔 text，但其数量随
     chunk 边界与空行增删而变化，无法在拼接边界精确对齐（多/少一个 "\n" 会让
     HAST 与全量 parse 不一致）。统一做法：各段剥去首尾空白 text 后重建段间
     分隔符——与 toHast 的 newline-join 语义一致，段内分隔原样保留。 */
  const localSeg: HastContent[] = [];
  for (const c of local.hast.children as HastContent[]) {
    localSeg.push(isMdlAnchor(c) ? shiftAnchor(c, baseLine) : c);
  }
  const hastChildren: HastContent[] = [];
  const pushSeg = (seg: HastContent[]): void => {
    while (seg.length) {
      const f = seg[0];
      if (f.type === "text" && !(f as { value?: string }).value?.trim()) seg.shift();
      else break;
    }
    while (seg.length) {
      const l = seg[seg.length - 1];
      if (l.type === "text" && !(l as { value?: string }).value?.trim()) seg.pop();
      else break;
    }
    if (!seg.length) return;
    if (hastChildren.length) {
      hastChildren.push({ type: "text", value: "\n" } as HastContent);
    }
    hastChildren.push(...seg);
  };
  pushSeg([...(headChildren as HastContent[])]);
  pushSeg(localSeg);
  {
    const tailSeg: HastContent[] = [];
    for (const c of tailChildren as HastContent[]) {
      tailSeg.push(isMdlAnchor(c) ? shiftAnchor(c, delta) : c);
    }
    pushSeg(tailSeg);
  }
  const hast: HastRoot = { type: "root", children: hastChildren } as unknown as HastRoot;

  /* 行号修正走克隆（P0 不变量：绝不原地改共享节点）——prev.root 的子节点
     可能被上层快照/派生树引用，原地 +delta 会让旧快照行号漂移 */
  const shiftLine = <N extends MdastContent>(node: N, by: number): N => {
    if (!node.position) return node;
    return {
      ...node,
      position: {
        ...node.position,
        start: { ...node.position.start, line: node.position.start.line + by },
        end: { ...node.position.end, line: node.position.end.line + by },
      },
    } as N;
  };
  const children: MdastContent[] = [
    ...prev.root.children.slice(0, i0),
    ...local.children.map((n) => shiftLine(n, baseLine)),
    ...prev.root.children.slice(i1 + 1).map((n) => shiftLine(n, delta)),
  ];
  const root: Root = {
    ...prev.root,
    children,
  };

  return {
    root,
    hast,
    blocks,
    full: false,
    incrementalCount: incCount + 1,
    lastFullAt: prev.lastFullAt ?? 0,
    /* 段级补丁：blocks 与 segments 一一对应（锚数 === 块数不变量已在上文校验），
       被替换的段区间 = 被替换的块区间 [i0, i1] */
    patch: { segStart: i0, segRemoved: i1 - i0 + 1, segAdded: local.blocks.length },
    refs: buildRefsSnapshot(refsBaseline),
    refsBaseline,
  };
}

export { blocksCoverDoc, countTextAs, splitLines };
