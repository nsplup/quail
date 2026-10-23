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
 * 块行界由锚 comment 驱动（blocksFromHast），供滚动同步 / 大纲 / 增量解析使用。
 */
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkSlug from "remark-slug";
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
} from "mdast";
import type { PreviewBlock, OutlineItem } from "../types";
import { rewriteImageSrc } from "../imgproxy";
import {
  blockIndexForLine,
  blocksCoverDoc,
  countTextAs,
  splitLines,
} from "./blocks";

/* remark-slug 自带的 @types/mdast / vfile 版本与项目顶层 unified 实例存在
   结构性版本差（dual-package type 实例），对统一管线做一次收窄转换 */
const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkSlug as unknown as Plugin<[]>);

/** Markdown 源码 → mdast AST（含 GFM 扩展：表格 / 任务列表 / 删除线 / 自动链接 / 脚注）。
 * remark 转换阶段（run）在此同步执行：remark-slug 为标题注入 GitHub 风格 slug id
 * （data.hProperties.id，经 toHast 落为元素 id 属性）——页内锚点跳转的定位依据。
 * 注意：增量路径的局部 chunk 独立 parse，标题 id 去重仅在其 chunk 内生效，
 * 与全量 parse 的文档级去重可能存在差异（锚点跳转取首个命中，且 idle 自愈
 * 全量重建会最终对齐）。 */
export function parseMarkdown(src: string): Root {
  return processor.runSync(processor.parse(src)) as unknown as Root;
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
 *   （remark-slug）与脚注定义 / 回链 id 的载体；
 * - md-image 进 tagNames：编译期 image handler 产物的容器标签
 *   （未知标签默认被 unwrap，MarkdownImage 组件容器会丢失）；
 * - data* 进 '*' 属性：md-image 的 data-src / data-alt 与 data-inline
 *   等标注（hast 属性键经规范化可能为 dataSrc 或 data-src，
 *   'data*' 通配两者；后者由 annotateImageContext 在净化后写入，
 *   此处仅作声明）。
 */
const sanitizeSchema = {
  ...defaultSchema,
  allowComments: true,
  clobberPrefix: "",
  tagNames: [...(defaultSchema.tagNames ?? []), "md-image"],
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
}

/** mdast-util-to-hast state 中本管线消费的最小定义查找接口 */
interface MdastToHastState {
  definitionById: Map<string, { url?: string | null }>;
}

/**
 * 未定义引用的字面回退（与 mdast-util-to-hast 默认 imageReference 行为一致）：
 * 全写 `![alt][id]`、收窄 `![alt][]`、缩写 `![alt]` 分别还原为对应源码文本。
 * （alt 兼容 null：mdast ImageReference.alt 可为 string | null | undefined）
 */
function revertReferenceText(node: Reference & { alt?: string | null }): string {
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

function mdastToHastRaw(root: Root): RawResult {
  const hast = toHast(root as never, {
    allowDangerousHtml: true,
    // <img> → <md-image>（渲染层 MarkdownImage 组件的容器标签）：
    // data-src 经 ImgProxy 重写（本地白名单 / 远程缓存）
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
      // 链接引用式图片（![alt][id] / ![alt][] / ![alt]）在 mdast 中是
      // imageReference 节点，定义解析发生在 remark-parse 内部，toHast 默认
      // handler 会直接产出普通 <img>——绕过上面的 image handler，
      // 导致此类图片不走 MarkdownImage 组件（无 ImgProxy 重写 / 三态占位）。
      // 这里按默认 handler 的语义（definitionById 大写键查找；未定义引用
      // 回退字面文本）把可解析的引用也归一到 md-image：
      imageReference: ((state: MdastToHastState, node: ImageReference) => {
        const def = state.definitionById.get(String(node.identifier).toUpperCase());
        if (!def) {
          // 未定义引用：回退字面文本（text 节点；handler 返回值不会被
          // mdast-util-to-hast 自动包装成节点，必须显式给 {type:"text"}）
          return {
            type: "text",
            value: revertReferenceText(node),
          } as unknown as HastContent;
        }
        return {
          type: "element",
          tagName: "md-image",
          properties: {
            "data-src": rewriteImageSrc(def.url ?? ""),
            "data-alt": node.alt ?? "",
          },
          children: [],
        } as unknown as HastContent;
      }) as never,
    } as never,
  }) as HastRoot;
  /* 表格来源标记（Markdown vs raw HTML）：
   * - Markdown（GFM）表格在 toHast 产物上先打 data-md-table，再进入
   *   rehype-raw 融合 / sanitize。实测（hast-util-raw 9）融合保留既有元素的
   *   properties（md-image 的 data-src 同理），且 'data*' 在 sanitize 白名单，
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
  // rehype-sanitize 净化（XSS 白名单）。必须在 rehype-raw 融合之后——
  // 融合前 raw HTML 只是 text / raw 节点，净化形同虚设；
  // convertHtmlImgToMdImage / annotateImageContext 在其后执行，
  // 其写入/迁移的属性无需进 schema。sanitize 重建整棵树（非 in-place），
  // 后续步骤全部改用其产物。
  const sanitized = rehypeSanitize(sanitizeSchema)(result as never) as unknown as HastRoot;
  // rehype-raw 融合后，HTML 语法书写的 <img>（含嵌在其他 HTML 标签内）只是
  // 普通元素——image/imageReference handler 只作用于 Markdown 语法的图片，
  // 管不到 raw 路径。这里把融合树中的 <img> 归一化为 md-image 容器，
  // 与 Markdown 语法图片走同一 MarkdownImage 组件（ImgProxy 重写 / 三态占位）。
  if (hasRaw) convertHtmlImgToMdImage(sanitized);
  // 融合后仍无 data-md-table 标记的 <table> 即 raw HTML 来源（融合会原样
  // 保留 markdown 侧属性，见 markMarkdownTables 注释）→ 补打 html 来源标记
  markHtmlTables(sanitized);
  // 剥除 HAST position：渲染层只消费结构/文本，不读行号（行号在锚 comment 与
  // mdast root 上）；统一剥除后增量（局部转换、position 为 chunk 行号）与全量
  // （全文行号）的 HAST 结构完全一致，渲染层引用对比/快照测试不受干扰。
  for (const n of sanitized.children as HastContent[]) stripHastPosition(n);
  annotateImageContext(sanitized);
  return { hast: sanitized, hasRaw };
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
 * 把融合树中的 <img>（HTML 语法书写的图片，含嵌在其他 HTML 标签内）原地
 * 替换为 md-image 容器（in-place），与 Markdown 语法图片（image /
 * imageReference handler 产物）走同一 MarkdownImage 组件。
 * 仅迁移 src / alt（组件消费的属性）；width/height/style 等由 HTML 语法
 * 直接控制的属性不迁移——与块级/行内分派语义（annotateImageContext）保持一致。
 */
function imgToMdImage(el: HastElement): HastElement {
  const props = (el.properties ?? {}) as Record<string, unknown>;
  return {
    type: "element",
    tagName: "md-image",
    properties: {
      "data-src": rewriteImageSrc(String(props.src ?? "")),
      "data-alt": String(props.alt ?? ""),
    },
    children: [],
  };
}

function convertHtmlImgToMdImage(node: HastRoot | HastContent): void {
  const kids = (node as { children?: HastContent[] }).children;
  if (!Array.isArray(kids)) return;
  for (let i = 0; i < kids.length; i++) {
    const c = kids[i];
    if (c.type === "element" && (c as HastElement).tagName === "img") {
      kids[i] = imgToMdImage(c as HastElement);
      continue;
    }
    convertHtmlImgToMdImage(c);
  }
}

/* ---------------- 图片上下文标注（块级 vs 行内） ---------------- */

/** 是否 md-image 元素（编译期 image handler 的产物） */
const isMdImageEl = (n: HastContent): boolean =>
  n.type === "element" && (n as { tagName?: string }).tagName === "md-image";

/** 是否空白 text 节点 */
const isBlankText = (n: HastContent): boolean =>
  n.type === "text" && !((n as { value?: string }).value ?? "").trim();

/**
 * 独立图片段判定：p 的 children 全部为 md-image / 空白 text /
 * 「内部同样只含 md-image+空白的 <a>」，且**恰好一张图**。
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
 * 给每个 md-image 标注渲染上下文：块级（独立成段，含 <a> 包裹）不标注，
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

/** mdast 根 → HAST 根（含行号锚；raw HTML 已融合） */
export function rootToHast(root: Root): HastRoot {
  return mdastToHastRaw(root).hast;
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
function blocksFromHast(
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
  claimLead = true
): { children: MdastContent[]; hast: HastRoot; blocks: PreviewBlock[] | null } {
  const chunk = lines.slice(fromLine - 1, toLine).join("\n");
  // 与 parseMarkdown 同链路：runSync 执行 remark 转换（remark-slug 注入标题 id）
  const root = processor.runSync(processor.parse(chunk)) as unknown as Root;
  const parsed = mdastToHastRaw(root);
  // 局部 chunk 含 raw HTML（rehype-raw 融合）时块边界可能跨越区间外 → 保守全量
  const { blocks, unmapped } = parsed.hasRaw
    ? { blocks: null as PreviewBlock[] | null, unmapped: false }
    : blocksFromHast(parsed.hast, toLine - fromLine + 1, baseLine, claimLead);
  // 无法可靠映射 → 调用方保守全量
  return {
    children: root.children,
    hast: parsed.hast,
    blocks: unmapped || !blocks ? null : blocks,
  };
}

export function buildBlocksIncremental(
  prev: IncrementalParseState,
  nextSrc: string,
  forceFull: boolean
): IncrementalParseResult {
  const runFull = (): IncrementalParseResult => {
    const root = parseMarkdown(nextSrc);
    const hast = rootToHast(root);
    return {
      root,
      hast,
      blocks: buildBlocks(root, nextSrc),
      full: true,
      incrementalCount: 0,
      lastFullAt: Date.now(),
      /* 全量结果不走补丁：主线程收到 full 标记后整体重建段列表 */
      patch: { segStart: 0, segRemoved: 0, segAdded: 0 },
    };
  };

  const incCount = prev.incrementalCount ?? 0;
  if (
    forceFull ||
    !prev.root ||
    !prev.src ||
    prev.blocks.length === 0
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
  // i0 > 0：chunk 之上有可复用块（head）→ 前导空行由 head 末块吸收
  //（与全量 emit(a-1) 语义对齐）；i0 === 0：chunk 起始于文档首行，
  // 无 head 可吸收 → 保持首块自补（与全量路径文档首块行为一致）
  const local = parseRange(nextSrc, nextLines, nextStart, nextEnd, baseLine, i0 === 0);
  if (!local.blocks) return runFull(); // 局部含 raw 融合，无法可靠映射 → 全量

  const headBlocks = prev.blocks.slice(0, i0);
  const tailBlocks = prev.blocks.slice(i1 + 1);

  /* 前导空行归属对齐：chunk 首块不再回拉认领锚前空行（claimLead=false），
     改由 head 末块把 endLine 延到首块锚前一行为止。此前首块 startLine
     被拉回 chunk 起点，行数变化型编辑后块行界相对真实锚点永久前移
     （滚动同步/光标定位按行界选块随之错位，且无法自愈）。 */
  if (local.blocks.length > 0 && headBlocks.length > 0) {
    headBlocks[headBlocks.length - 1].endLine = local.blocks[0].startLine - 1;
  }

  // 行号平移（尾部块整体 +delta）+ 位置重排
  const blocks: PreviewBlock[] = [...headBlocks, ...local.blocks, ...tailBlocks];
  for (let i = 0; i < blocks.length; i++) {
    blocks[i].index = i;
  }
  for (const b of tailBlocks) {
    b.startLine += delta;
    b.endLine += delta;
  }
  if (local.blocks.length === 0) {
    /* 局部区间无锚（纯空行/空 chunk）：不产块，但区间 [nextStart..nextEnd] 的行
       必须有人认领——并入相邻复用块，否则 head/tail 间出现行界空洞。
       注意必须在 tail 平移之后执行（否则赋值会被随后的 += delta 二次修改） */
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
  };
}

export { blocksCoverDoc, countTextAs, splitLines };
