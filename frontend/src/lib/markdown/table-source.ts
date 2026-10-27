/**
 * 可编辑表格的源码侧支撑模块（主线程，EditableTable.svelte 专属）。
 *
 * 职责：
 * - 从编辑器源码中定位表格的行区间（种子区间优先 = 所在预览块的行界，
 *   失败时全文兜底搜索），并把源码解析为「原始单元格源」矩阵；
 * - 按表格来源（解析链路 data-md-table / data-html-table 标记，见
 *   markdown-core.ts）把单元格矩阵序列化为格式化后的源码：
 *   MARKDOWN 来源 → 对齐填充的 GFM 表格；HTML RAW 来源 → 缩进规整的
 *   <table> HTML。序列化产物即反向更新编辑区的写入内容。
 *
 * 与渲染的关系：单元格「显示内容」完全来自增量解析 worker 产出的 HAST
 * （单元格内的 markdown 解析不在此重复做）；本模块只服务于「反向更新」
 * 需要的原始源文本读写。
 */
import type { Element as HastElement, Root as HastRoot, RootContent as HastContent } from "hast";
import { toHtml } from "hast-util-to-html";
import { readNumberAttr } from "./hast-attrs";
import { compileMarkdown } from "./markdown-core";

export type TableOrigin = "markdown" | "html";
export type TableAlign = "left" | "center" | "right";
/** 锚定单元格：序列化时记录其在输出文本内的字符偏移（0-based） */
export interface CellMark {
  r: number;
  c: number;
}

export interface SerializedTable {
  text: string;
  /** anchor 单元格内容首字符的偏移；未传 anchor 或越界回落为 0 */
  cellOffset: number;
}


/**
 * 结构化单元格源（P1）：
 * - raw：单元格原始源文本（lang 决定其语言——markdown inline 或 HTML 片段）；
 * - lang：HTML 来源单元格反编译成功 → "markdown"（raw 为可逆 md inline）；
 *   失败 → "html"（raw 保留原始 HTML 片段，整表降级静态，见 P4）；
 * - spans：合并跨度（HTML 来源从 DOM 读取；markdown 来源恒为 1）；
 * - attrs：属性白名单（align / style / data-*，HTML 来源序列化时写回）。
 */
export interface CellSource {
  raw: string;
  lang: "markdown" | "html";
  spans: { colspan: number; rowspan: number };
  attrs: Record<string, string>;
}

/** 空单元格（补齐矩阵 / 新增行列用；默认 markdown 语言） */
export function emptyCell(): CellSource {
  return { raw: "", lang: "markdown", spans: { colspan: 1, rowspan: 1 }, attrs: {} };
}

/** markdown inline 单元格（GFM 来源；无合并、无属性） */
export function markdownCell(raw: string): CellSource {
  return { raw, lang: "markdown", spans: { colspan: 1, rowspan: 1 }, attrs: {} };
}

/** 表格源码定位 + 解析结果（rows[0] = 表头行；markdown 来源恒有表头） */
export interface TableSource {
  origin: TableOrigin;
  /** 表格在源码中的行区间（1-based，含端点） */
  startLine: number;
  endLine: number;
  /** 当前表格源码文本（行区间漂移校验 / 就近重定位的锚文本，含行前缀） */
  text: string;
  /** 结构化原始单元格源矩阵（未渲染的 markdown / html 片段） */
  rows: CellSource[][];
  /** 列对齐（来自 markdown 分隔行或 HTML align/text-align；null = 默认） */
  aligns: (TableAlign | null)[];
  /** 是否含表头行（HTML 来源可能纯 tbody） */
  hasHeader: boolean;
  /**
   * 行前缀（与行区间一一对应：缩进 / 引用 > / 列表标记及其后空格）。
   * 序列化产物是「裸」行内容；回写时由 replaceLines(preservePrefix) 按
   * 现文档逐行保留前缀（见 P3），避免缩进/引用上下文被反向更新冲掉。
   */
  linePrefixes: string[];
  /** 源码缓存失效标记（回读失败等）：ensureSource 见 true 时强制重定位 */
  dirty: boolean;
  /**
   * 源码侧静态原因（P4）：HTML 来源任一单元格反编译失败（未知标签 /
   * 白名单外属性，CellSource.lang === "html"）→ "attrs"，整表降级
   * 静态（EditableTable.isStatic 的 "attrs" 分支）。markdown 来源恒无。
   */
  staticReason?: "attrs";
}

/**
 * 行前缀提取：行首到首个非空白内容之间的「结构前缀」——缩进、引用标记、
 * 列表标记（含其后空格）。与 replaceLines 的 preservePrefix 共用同一语义
 * （单一事实源；codemirrorSetup 从本模块导入）。
 */
const LINE_PREFIX_RE = /^([ \t]*(?:>[ \t]*)*(?:[-*+][ \t]+|\d+\.[ \t]+)?[ \t]*)/;
export function extractLinePrefix(line: string): string {
  return LINE_PREFIX_RE.exec(line)?.[1] ?? "";
}

/** 表格各行的前缀列表（行内容区 = 去前缀后的部分） */
export function extractLinePrefixes(text: string): string[] {
  return text.split("\n").map(extractLinePrefix);
}

/**
 * 块插入前缀：把光标所在行的「结构前缀」转换为表格/代码块等块级内容
 * 应使用的每行前缀。
 *
 * - 纯空白 / 引用前缀：原样保留（引用块内块级内容合法）；
 * - 列表标记（- / * / + / 1. 及后随空白）：替换为等宽空白——列表项内容层
 *   不能以列表标记开头，等宽空白使块成为列表项内容且与 1. 的多位标记对齐；
 * - 混合（> - item）：引用部分保留，列表标记部分替换。
 *
 * 与 extractLinePrefix 共用同一语义源（LINE_PREFIX_RE）。
 */
export function blockInsertPrefix(lineText: string): string {
  const prefix = extractLinePrefix(lineText);
  // 仅匹配「前缀末尾的列表标记 + 其后空白」，替换为等宽空白
  return prefix.replace(/([-*+]|\d+\.)\s+$/, (m) => " ".repeat(m.length));
}

/**
 * @deprecated 兼容视图：TableSource.rows 已结构化为 CellSource[][]。
 * 新代码直接读写 CellSource（raw / lang / spans / attrs）；本视图仅供
 * 渐进迁移期的只读消费，禁止依赖它做反向更新。
 */
export function rawRows(s: TableSource): string[][] {
  return s.rows.map((row) => row.map((c) => c.raw));
}

/* ---------------- 来源标记读取（与 markdown-core.ts 的标记约定对齐） ---------------- */

const MD_TABLE_FLAG = "data-md-table";
const HTML_TABLE_FLAG = "data-html-table";

function flagValue(el: HastElement, flag: string): unknown {
  const props = (el.properties ?? {}) as Record<string, unknown>;
  const camel = flag.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());
  return props[flag] ?? props[camel];
}

/** 标记属性存在性：兼容字符串 / 数字 / 布尔值（false / "false" / 0 / 空串视为无标记） */
function hasTableFlag(el: HastElement, flag: string): boolean {
  const v = flagValue(el, flag);
  if (v == null || v === false || v === "" || v === 0) return false;
  if (typeof v === "string" && v.trim().toLowerCase() === "false") return false;
  return true;
}

/** HAST table 元素 → 表格来源（缺标记时按 markdown 处理：GFM 表格是常态） */
export function tableOriginFromEl(el: HastElement): TableOrigin {
  if (hasTableFlag(el, HTML_TABLE_FLAG)) return "html";
  return "markdown";
}

/**
 * HAST 表格静态化判定（纯函数，可单测）：
 * colspan / rowspan 合并的表格禁止原地编辑——朴素序列化会破坏合并结构。
 * span 读取经 readNumberAttr（兼容 colSpan/colspan 键名、number/string 值，
 * 非法值回落 1），与 domRowCells 的 DOM 侧读取保持同一语义。
 */
export function isStaticTable(el: HastElement): { static: boolean; reason?: "span" } {
  const hasSpan = collectRows(el).some((row) =>
    row.cells.some((c) => {
      const p = (c.properties ?? {}) as Record<string, unknown>;
      return readNumberAttr(p, "colspan") > 1 || readNumberAttr(p, "rowspan") > 1;
    })
  );
  return hasSpan ? { static: true, reason: "span" } : { static: false };
}

/* ---------------- HAST → 显示结构（thead/tbody 分组的行列表） ---------------- */

export interface DisplayRow {
  /** 行在表格中的全局下标（thead 行在前，与 TableSource.rows 对齐） */
  idx: number;
  cells: HastElement[];
  isHeader: boolean;
}

/** 收集表格的行（只取 thead/tbody/table 的直接 tr 子级，忽略嵌套表格） */
export function collectRows(table: HastElement): DisplayRow[] {
  const rows: DisplayRow[] = [];
  let idx = 0;
  const pushRow = (tr: HastElement, isHeader: boolean) => {
    const cells = (tr.children ?? []).filter(
      (c): c is HastElement => c.type === "element" && ((c as HastElement).tagName === "td" || (c as HastElement).tagName === "th")
    );
    rows.push({ idx: idx++, cells, isHeader });
  };
  for (const c of table.children ?? []) {
    if (c.type !== "element") continue;
    const el = c as HastElement;
    if (el.tagName === "thead" || el.tagName === "tbody" || el.tagName === "tfoot") {
      for (const r of el.children ?? []) {
        if (r.type === "element" && (r as HastElement).tagName === "tr") pushRow(r as HastElement, el.tagName === "thead");
      }
    } else if (el.tagName === "tr") {
      pushRow(el, false);
    }
  }
  return rows;
}

/** 从 HAST 读取每列对齐（取首个非空单元格的 align / text-align 样式） */
export function readAlignsFromEl(table: HastElement, colCount: number): (TableAlign | null)[] {
  const aligns: (TableAlign | null)[] = new Array(colCount).fill(null);
  for (const row of collectRows(table)) {
    row.cells.forEach((cell, ci) => {
      if (ci >= colCount || aligns[ci]) return;
      const p = (cell.properties ?? {}) as Record<string, unknown>;
      const a = String(p.align ?? "").toLowerCase();
      if (a === "left" || a === "center" || a === "right") {
        aligns[ci] = a;
        return;
      }
      const style = String(p.style ?? "");
      const m = /text-align\s*:\s*(left|center|right)/i.exec(style);
      if (m) aligns[ci] = m[1].toLowerCase() as TableAlign;
    });
    if (row.cells.length >= colCount) break;
  }
  return aligns;
}

/* ---------------- MARKDOWN（GFM）表格：源码解析 / 定位 / 序列化 ---------------- */

const DELIM_CELL = /^\s*:?-+:?\s*$/;

/** 按未转义的 | 切分（\| 还原为字面 |） */
function splitPipeCells(t: string): string[] {
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === "\\" && t[i + 1] === "|") {
      cur += "|";
      i++;
      continue;
    }
    if (ch === "|") {
      cells.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur);
  return cells;
}

/** 表格行源码 → 原始单元格源（去掉首尾包裹管道，去转义） */
// table-source.ts
function markdownRowCells(line: string): string[] {
  // 行前缀（缩进 / > / 列表标记）先行剥离：引用块内表格行形如
  // "> | a | b |"，line.trim() 去不掉 "> "，不走 extractLinePrefix
  // 就会把 ">" 当成第一个单元格内容，isDelimiterRow 随之永远 false，
  // extractMarkdownTableRange 返回 null → locateTableSource 返回 null
  // → ensureSource 返回 null → startEdit 静默返回（无法进入编辑）。
  const prefixLen = extractLinePrefix(line).length;
  let t = line.slice(prefixLen).trim();
  if (t.startsWith("|")) t = t.slice(1);
  const hasTrailing = /(^|[^\\])\|$/.test(t) || t === "|";
  const cells = splitPipeCells(t);
  if (hasTrailing && cells.length > 0) cells.pop();
  return cells.map((c) => c.trim());
}

/** GFM 分隔行判定（| --- | :--: | …） */
function isDelimiterRow(line: string): boolean {
  const t = line.trim();
  if (!t.includes("-") || !t.includes("|")) return false;
  const cells = markdownRowCells(t);
  return cells.length > 0 && cells.every((c) => DELIM_CELL.test(c));
}

function parseAlignsFromDelimiter(line: string, colCount: number): (TableAlign | null)[] {
  const aligns: (TableAlign | null)[] = new Array(colCount).fill(null);
  markdownRowCells(line).forEach((c, i) => {
    if (i >= colCount) return;
    const l = c.startsWith(":");
    const r = c.endsWith(":");
    aligns[i] = l && r ? "center" : r ? "right" : l ? "left" : null;
  });
  return aligns;
}

/** 在行数组中定位 GFM 表格（0-based，含端点；找不到返回 null） */
export function extractMarkdownTableRange(lines: string[]): { start: number; end: number } | null {
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].includes("|")) continue;
    if (!isDelimiterRow(lines[i + 1])) continue;
    let end = i + 1;
    let j = i + 2;
    // 表体：连续的含管道非空行
    while (j < lines.length && lines[j].trim() !== "" && lines[j].includes("|")) {
      end = j;
      j++;
    }
    return { start: i, end };
  }
  return null;
}

/** markdown 表格源码文本 → 结构化行矩阵 + 对齐（rows[0] = 表头） */
function parseMarkdownTable(text: string): { rows: CellSource[][]; aligns: (TableAlign | null)[] } {
  const lines = text.split("\n");
  const rows: CellSource[][] = [];
  let aligns: (TableAlign | null)[] = [];
  lines.forEach((line, i) => {
    if (i === 1) {
      // 分隔行：不进入内容矩阵，只取列对齐
      const first = markdownRowCells(lines[0]);
      aligns = parseAlignsFromDelimiter(line, first.length);
      return;
    }
    rows.push(markdownRowCells(line).map(markdownCell));
  });
  return { rows, aligns };
}

/* ---------------- HTML RAW 表格：源码解析 / 定位 / 序列化 ---------------- */

/** 在行数组中定位 HTML 表格（0-based，含端点；支持嵌套计数） */
export function extractHtmlTableRange(lines: string[]): { start: number; end: number } | null {
  for (let i = 0; i < lines.length; i++) {
    if (!/<table[\s>]/i.test(lines[i])) continue;
    let depth = 0;
    for (let j = i; j < lines.length; j++) {
      depth += (lines[j].match(/<table[\s>]/gi) ?? []).length;
      depth -= (lines[j].match(/<\/table\s*>/gi) ?? []).length;
      if (depth <= 0) return { start: i, end: j };
    }
    return null; // 未闭合：不认
  }
  return null;
}

/** HTML 表格源码文本 → 结构化行矩阵 + 对齐 + 表头判定（DOMParser 解析）。
 * P4：单元格逐格反编译（decodeCell）；任一格失败（lang 停留 "html"）→
 * 返回 staticReason: "attrs"，调用方整表降级静态。 */
function parseHtmlTable(text: string): { rows: CellSource[][]; aligns: (TableAlign | null)[]; hasHeader: boolean; staticReason?: "attrs" } {
  const doc = new DOMParser().parseFromString(text, "text/html");
  const table = doc.querySelector("table");
  if (!table) return { rows: [] as CellSource[][], aligns: [], hasHeader: false };
  const rows: CellSource[][] = [];
  let aligns: (TableAlign | null)[] = [];
  let alignsFilled = false;
  let hasHeader = false;
  /* 手动遍历直接子级（thead/tbody/tfoot/tr），天然排除单元格内嵌套表格，
     且不依赖 :scope 选择器（部分 WebView / shim 环境支持不完整） */
  for (const section of Array.from(table.children)) {
    const tag = (section.tagName || "").toLowerCase();
    if (tag === "thead") {
      hasHeader = true;
    }
    if (tag === "thead" || tag === "tbody" || tag === "tfoot") {
      for (const tr of Array.from(section.children)) {
        if ((tr.tagName || "").toLowerCase() !== "tr") continue;
        const cells = domRowCells(tr);
        rows.push(cells);
        /* 列对齐取自首个收集到的行（thead 行或首行），与序列化写回一致 */
        if (!alignsFilled) {
          aligns = cells.map((c) => cellAlignOf(c));
          alignsFilled = true;
        }
      }
    } else if (tag === "tr") {
      const cells = domRowCells(section);
      rows.push(cells);
      if (!alignsFilled) {
        aligns = cells.map((c) => cellAlignOf(c));
        alignsFilled = true;
      }
    }
  }
  /* 无 thead 的表格：首个单元格行若含 <th> 也视为表头（HTML 常见写法） */
  if (!hasHeader && rows.length > 0) {
    for (const section of Array.from(table.children)) {
      const tag = (section.tagName || "").toLowerCase();
      const trs = tag === "tr" ? [section] : ["tbody", "tfoot"].includes(tag) ? Array.from(section.children).filter((el) => (el.tagName || "").toLowerCase() === "tr") : [];
      if (trs.length > 0 && trs[0] && Array.from(trs[0].children).some((el) => (el.tagName || "").toLowerCase() === "th")) {
        hasHeader = true;
      }
      break;
    }
  }
  /* P4：任一格反编译失败（lang 停留 "html"）→ 整表静态（不可原地编辑，
   * 朴素序列化无法保真未知标签/白名单外属性） */
  const staticReason = rows.some((r) => r.some((c) => c.lang === "html"))
    ? ("attrs" as const)
    : undefined;
  return { rows, aligns, hasHeader, staticReason };
}

/** CellSource → 列对齐（align 属性优先，其次 style 的 text-align） */
function cellAlignOf(c: CellSource): TableAlign | null {
  const a = (c.attrs.align ?? "").toLowerCase();
  if (a === "left" || a === "center" || a === "right") return a;
  const m = /text-align\s*:\s*(left|center|right)/i.exec(c.attrs.style ?? "");
  return m ? (m[1].toLowerCase() as TableAlign) : null;
}

/* ---------------- 可逆 Codec（P2）：单元格 markdown inline ↔ HTML 片段 ----------------
 * 约定（与方案一致）：
 * - decode 方向（HTML → md）只认 <br>/<strong>/<em>/<code> 与 &nbsp;/
 *   &#32; 实体；遇未知标签 / 注释 → 返回原始 HTML 并标记 c.lang = "html"
 *   （调用方降级为静态，见 P4）；
 * - encode 方向（md → HTML）复用 compileMarkdown（与 worker 同一条编译
 *   链路，不引入第二套解析）取 inline 子节点，soft line break 显式转
 *   <br>；首尾空格以 &#32; 数字字符引用补回（markdown 编译会剥离首尾
 *   空白，实体解码后与源串逐字相等）；
 * - 双向互逆：decodeCell(encodeCell(x)) === x（assertRoundTrip 性质检查）。 */

/** DOM 内联子节点 → markdown inline 文本；未知标签返回 null（保守失败） */
function decodeInline(nodes: Node[]): string | null {
  let out = "";
  for (const n of nodes) {
    if (n.nodeType === 3) {
      out += (n.textContent ?? "").replace(/\u00A0/g, " ");
      continue;
    }
    if (n.nodeType === 8) continue;          // ← 注释节点跳过，不视为失败
    if (n.nodeType !== 1) return null;
    const el = n as Element;
    const tag = (el.tagName || "").toLowerCase();
    if (tag === "br") { out += "\n"; continue; }
    const wrap =
      tag === "strong" ? "**" :
      tag === "em" ? "*" :
      tag === "code" ? "`" : null;
    if (wrap == null) return null;           // 未知标签 → 失败
    const inner = decodeInline(Array.from(el.childNodes));
    if (inner == null) return null;
    out += wrap + inner + wrap;
  }
  return out;
}

/**
 * 单元格源解码（HTML → markdown inline）：
 * - c.lang === "markdown"：原样返回（幂等）；
 * - c.lang === "html"：解析 c.raw 为 HTML 片段做显式反编译（<br>→\n、
 *   &nbsp;→空格、<strong>/<em>/<code> → md 记号）——不再依赖 textContent
 *   恰好保留换行的隐式行为；成功后 c.raw 更新为 md 文本、c.lang = "markdown"；
 *   失败（未知标签/结构）返回原始 HTML 并保持 c.lang = "html"。
 */
export function decodeCell(c: CellSource): string {
  if (c.lang !== "html") return c.raw;

  // 单元格 raw 是内联 HTML 片段（strong/em/code/br/文本）。
  // 用 div.innerHTML 解析是片段解析的标准路径，避开各 DOM 实现
  // 对 table 上下文 / 孤儿 <td> 的解析差异（happy-dom 下
  // DOMParser 解析完整 table 后 querySelector("td") 会返回 null）。
  let decoded: string | null = null;
  try {
    const box = document.createElement("div");
    box.innerHTML = c.raw;
    decoded = decodeInline(Array.from(box.childNodes));
  } catch {
    decoded = null;
  }

  if (decoded == null) {
    c.lang = "html";            // 保留原始 HTML 片段，调用方据此降级（P4）
    return c.raw;
  }

  // 剥离块级排版残留的首尾空白（含换行的多行源码格式）；纯空格运行保留
  const cleaned = decoded
    .replace(/^[ \t]*\n[ \t]*/, "")
    .replace(/[ \t]*\n[ \t]*$/, "");
  c.lang = "markdown";
  c.raw = cleaned;
  return cleaned;
}

/** hast 内联子节点数组中的 soft line break（文本节点内的 \n）→ <br> 元素 */
function softBreaksToBr(children: HastContent[]): HastContent[] {
  const br = (): HastContent => ({ type: "element", tagName: "br", properties: {}, children: [] });
  const out: HastContent[] = [];
  let lastWasBr = false;
  for (const n of children) {
    if (n.type === "text") {
      const parts = n.value.split("\n");
      parts.forEach((part, i) => {
        if (i > 0) {
          if (!lastWasBr) out.push(br());
          lastWasBr = true;
        }
        if (part !== "") {
          out.push({ type: "text", value: part });
          lastWasBr = false;
        }
      });
    } else {
      out.push(n);
      lastWasBr = n.type === "element" && (n as HastElement).tagName === "br";
    }
  }
  return out;
}

/**
 * 单元格源编码（markdown inline → HTML 片段）：
 * - origin === "markdown"：原样返回（\| 转义与换行→<br> 由 serialize 处理）；
 * - origin === "html"：compileMarkdown(s) 取 inline 子节点（段落拍平，
 *   段间以 <br> 衔接）→ toHtml 序列化（文本节点的 &<> 自动转义）→
 *   soft break 已显式转 <br>；首尾空格以 &#32; 补回。
 */
export function encodeCell(s: string, origin: TableOrigin): string {
  if (origin === "markdown") return s;
  const root = compileMarkdown(s);
  const children: HastContent[] = [];
  const visible = root.children.filter((n) => n.type !== "comment");
  visible.forEach((n, i) => {
    if (i > 0) {
      children.push({ type: "element", tagName: "br", properties: {}, children: [] });
    }
    if (n.type === "element" && (n as HastElement).tagName === "p") {
      children.push(...(n as HastElement).children);
    } else {
      children.push(n);
    }
  });
  let html = toHtml({ type: "root", children: softBreaksToBr(children) } as HastRoot);
  const lead = /^[ \t]*/.exec(s)?.[0].length ?? 0;
  const trail = /[ \t]*$/.exec(s)?.[0].length ?? 0;
  if (lead > 0) html = "&#32;".repeat(lead) + html;
  if (trail > 0) html += "&#32;".repeat(trail);
  return html;
}

/** 往返性质检查（测试/开发断言）：decodeCell(encodeCell(x)) === x */
export function assertRoundTrip(s: string, origin: TableOrigin): boolean {
  if (origin === "markdown") return decodeCell(markdownCell(s)) === s;
  const c: CellSource = {
    raw: encodeCell(s, "html"),
    lang: "html",                       // ← 必须显式置为 html
    spans: { colspan: 1, rowspan: 1 },
    attrs: {},
  };
  return decodeCell(c) === s;
}

/** 单元格属性白名单（DOM 节点 → CellSource.attrs）：align / style / data-* */
function domCellAttrs(el: Element): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const name of Array.from(el.getAttributeNames?.() ?? [])) {
    const v = el.getAttribute(name) ?? "";
    if (name === "align" || name === "style" || name.startsWith("data-")) {
      attrs[name] = v;
    }
  }
  return attrs;
}

/** 收集一个 <tr> 的直接子级单元格（结构化源：raw + spans + attrs）。
 * raw 提取：innerHTML 原始片段（lang "html"）→ decodeCell 显式反编译
 *（<br>→\n、&nbsp;→空格、<strong>/<em>/<code>→md 记号；未知标签保持
 * lang "html" 并保留原始 HTML，调用方降级为静态，见 P4）——不再依赖
 * textContent 恰好保留换行的隐式行为。 */
function domRowCells(tr: Element): CellSource[] {
  return Array.from(tr.children)
    .filter((el) => ["td", "th"].includes((el.tagName || "").toLowerCase()))
    .map((el) => {
      const he = el as HTMLElement;
      const colspan = readNumberAttr(
        { colspan: he.getAttribute("colspan"), rowspan: he.getAttribute("rowspan") } as Record<string, unknown>,
        "colspan",
      );
      const rowspan = readNumberAttr(
        { colspan: he.getAttribute("colspan"), rowspan: he.getAttribute("rowspan") } as Record<string, unknown>,
        "rowspan",
      );
      const cell: CellSource = {
        raw: he.innerHTML ?? "",
        lang: "html",
        spans: { colspan, rowspan },
        attrs: domCellAttrs(el),
      };
      decodeCell(cell);
      /* 白名单外属性（class / id / width 等）：无法保真序列化 → 视为
       * 反编译失败（lang 强制 "html"，parseHtmlTable 据此整表静态） */
      const foreign = Array.from(el.getAttributeNames?.() ?? []).some(
        (n) =>
          n !== "align" &&
          n !== "style" &&
          n !== "colspan" &&
          n !== "rowspan" &&
          !n.startsWith("data-"),
      );
      if (foreign) cell.lang = "html";
      return cell;
    });
}

/* ---------------- 序列化（反向更新编辑区的写入内容） ---------------- */

/** 东亚宽字符按 2 列计的显示宽度（对齐填充用） */
function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    w += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  }
  return w;
}

function padCell(s: string, width: number, align: TableAlign | null): string {
  const gap = Math.max(0, width - displayWidth(s));
  if (align === "right") return " ".repeat(gap) + s;
  if (align === "center") {
    const l = Math.floor(gap / 2);
    return " ".repeat(l) + s + " ".repeat(gap - l);
  }
  return s + " ".repeat(gap);
}

function escapeMarkdownCell(s: string): string {
  // GFM 单元格首尾空白无意义（回读必然 trim），序列化时先归一化：
  // 否则源码写入 "|   text |" 而回读得 "text"，源码与内存矩阵分叉，
  // 用户侧看到的就是"用例 B 第 2 步不满足"。
  return s.trim().replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

/** rows → 对齐填充的 GFM 表格源码（rows[0] = 表头；恒输出分隔行）。
 * mark：锚定单元格，序列化时记录其内容首字符在输出文本内的偏移
 *（替换后光标落点，使兜底对齐目标落在表格附近而非文档顶部）。
 * 单元格内容取 CellSource.raw（lang 不区分——markdown 表格单元格源
 * 恒为 markdown inline；转义规则见 escapeMarkdownCell）。 */
export function serializeMarkdownTable(rows: CellSource[][], aligns: (TableAlign | null)[], mark?: CellMark): SerializedTable {
  const colCount = Math.max(1, ...rows.map((r) => r.length), aligns.length);
  const norm = rows.map((r) => {
    const cells = [...r];
    while (cells.length < colCount) cells.push(emptyCell());
    return cells.map((c) => escapeMarkdownCell(c.raw));
  });
  const widths: number[] = [];
  for (let c = 0; c < colCount; c++) {
    widths[c] = Math.max(3, ...norm.map((r) => displayWidth(r[c] ?? "")));
  }
  const alignOf = (c: number): TableAlign | null => aligns[c] ?? null;
  const lines = norm.map((r) => `| ${r.map((cell, c) => padCell(cell, widths[c], alignOf(c))).join(" | ")} |`);
  const delim = `| ${widths.map((w, c) => {
    const a = alignOf(c);
    const fill = (s: string) => padCell(s, w, null);
    if (a === "center") return fill(":" + "-".repeat(Math.max(1, w - 2)) + ":");
    if (a === "right") return fill("-".repeat(Math.max(1, w - 1)) + ":");
    if (a === "left") return fill(":" + "-".repeat(Math.max(1, w - 1)));
    return fill("-".repeat(w));
  }).join(" | ")} |`;

  const rowLines = [lines[0] ?? "", delim, ...lines.slice(1)];

  /* 记账：mark.r 行在最终输出中的位置——norm[0] 是输出第 0 行，
   * norm[r≥1] 排在分隔行之后（第 r+1 行）。行内前缀 =
   * "| " (2) + Σ_{c'<c} (paddedCell(c').length + " | " (3)) */
  let cellOffset = 0;
  if (mark && mark.r >= 0 && mark.r < norm.length) {
    const rowPos = mark.r === 0 ? 0 : mark.r + 1;
    const padded = norm[mark.r].map((cell, c) => padCell(cell, widths[c], alignOf(c)));
    const inLine = 2 + padded.slice(0, mark.c).reduce((n, p) => n + p.length + 3, 0);
    cellOffset = rowLines.slice(0, rowPos).reduce((n, l) => n + l.length + 1, 0) + inLine;
  }

  return { text: rowLines.join("\n"), cellOffset };
}


/** 属性值转义（引号 / &）：写回 <td>/<th> 属性白名单用 */
function escapeAttrValue(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/** CellSource → 单元格属性串（对齐 + 合并跨度 + 白名单属性）。
 * 对齐取单元格属性优先、列对齐数组兜底（新增列兜底 null = 默认）。
 *（span/attrs 的完整保留：span 表本身已被 isStatic 判静态不可编辑，
 * 此处保留仅保证「万一进入序列化」时结构不被静默破坏。） */
function cellAttrsOf(cell: CellSource, c: number, aligns: (TableAlign | null)[]): string {
  let s = "";
  const a = cell.attrs.align ?? aligns[c] ?? null;
  if (a && a !== "left") s += ` align="${a}"`;
  if (cell.spans.colspan > 1) s += ` colspan="${cell.spans.colspan}"`;
  if (cell.spans.rowspan > 1) s += ` rowspan="${cell.spans.rowspan}"`;
  if (cell.attrs.style) s += ` style="${escapeAttrValue(cell.attrs.style)}"`;
  for (const [k, v] of Object.entries(cell.attrs)) {
    if (k.startsWith("data-")) s += ` ${k}="${escapeAttrValue(v)}"`;
  }
  return s;
}

/**
 * rows → 缩进规整的 <table> HTML（P4：单元格语言统一）。
 * - 单元格内容按 CellSource 编码：lang "markdown" → encodeCell(raw, "html")
 *   （复用 compileMarkdown 编译为 inline HTML，与 worker 同链路）；
 *   lang "html"（反编译失败残留）→ 原始片段直写（此类表已静态，仅兜底）；
 * - 属性白名单（align / colspan / rowspan / style / data-*）逐格写回；
 * - 换行（单元格内 \n）经 encodeCell 显式转 <br>，不再整体转义。
 * mark：锚定单元格偏移（同 serializeMarkdownTable）。
 */
export function serializeHtmlTable(
  rows: CellSource[][],
  aligns: (TableAlign | null)[],
  hasHeader: boolean,
  mark?: CellMark
): SerializedTable {
  const colCount = Math.max(1, ...rows.map((r) => r.length));
  const norm = rows.map((r) => {
    const cells = [...r];
    while (cells.length < colCount) cells.push(emptyCell());
    return cells;
  });

  let cellOffset = 0;
  const out: string[] = ["<table>"];
  /** rowIdx：rows 矩阵行号（hasHeader 时 norm[0] → 0，norm[1..] → 1..n） */
  const emitRow = (cells: CellSource[], tag: "th" | "td", indent: string, rowIdx: number): void => {
    out.push(`${indent}<tr>`);
    cells.forEach((cell, c) => {
      const attrs = cellAttrsOf(cell, c, aligns);
      if (mark && rowIdx === mark.r && c === mark.c) {
        /* out 中已有行的总长 + 各行换行符，加本行前缀：
         * indent + "  " + "<" + tag + attrs + ">" */
        cellOffset = out.reduce((n, l) => n + l.length + 1, 0)
          + indent.length + 2 + tag.length + attrs.length + 1;
      }
      const content = cell.lang === "html" ? cell.raw : encodeCell(cell.raw, "html");
      out.push(`${indent}  <${tag}${attrs}>${content}</${tag}>`);
    });
    out.push(`${indent}</tr>`);
  };
  if (hasHeader && norm.length > 0) {
    out.push("  <thead>");
    emitRow(norm[0], "th", "    ", 0);
    out.push("  </thead>");
    if (norm.length > 1) {
      out.push("  <tbody>");
      norm.slice(1).forEach((r, i) => emitRow(r, "td", "    ", i + 1));
      out.push("  </tbody>");
    }
  } else {
    out.push("  <tbody>");
    norm.forEach((r, i) => emitRow(r, "td", "    ", i));
    out.push("  </tbody>");
  }
  out.push("</table>");
  return { text: out.join("\n"), cellOffset };
}


/** 底栏插入用：r 行 c 列的格式化 MARKDOWN 表格（空表头 + 空单元格） */
export function emptyMarkdownTable(rowCount: number, colCount: number): string {
  const rows: CellSource[][] = Array.from(
    { length: Math.max(1, rowCount) },
    () => Array.from({ length: Math.max(1, colCount) }, () => emptyCell()),
  );
  return serializeMarkdownTable(rows, []).text;  // ← 解构 .text
}


/* ---------------- 源码定位（种子块区间优先，全文兜底） ---------------- */

export interface LineRange {
  startLine: number;
  endLine: number;
}

function extractInRange(lines: string[], base: number, origin: TableOrigin): LineRange | null {
  const r = origin === "html" ? extractHtmlTableRange(lines) : extractMarkdownTableRange(lines);
  if (!r) return null;
  return { startLine: base + r.start, endLine: base + r.end };
}

/**
 * 在文档中定位表格源码：
 * 1. 种子区间（所在预览块的行界）内优先——顶层表格的块即表格本身；
 * 2. 种子内找不到（嵌套表格 / 块界漂移）→ 全文兜底搜索。
 */
export function locateTableSource(
  doc: string,
  seed: LineRange | null,
  origin: TableOrigin
): TableSource | null {
  const lines = doc.split("\n");
  let range: LineRange | null = null;
  if (seed && seed.startLine >= 1 && seed.endLine <= lines.length && seed.startLine <= seed.endLine) {
    range = extractInRange(lines.slice(seed.startLine - 1, seed.endLine), seed.startLine, origin);
  }
  if (!range) range = extractInRange(lines, 1, origin);
  if (!range) return null;
  const text = lines.slice(range.startLine - 1, range.endLine).join("\n");
  if (origin === "html") {
    const parsed = parseHtmlTable(text);
    if (parsed.rows.length === 0) return null;
    return {
      origin,
      ...range,
      text,
      rows: parsed.rows,
      aligns: parsed.aligns,
      hasHeader: parsed.hasHeader,
      linePrefixes: extractLinePrefixes(text),
      dirty: false,
      staticReason: parsed.staticReason,
    };
  }
  const parsed = parseMarkdownTable(text);
  if (parsed.rows.length === 0) return null;
  return {
    origin,
    ...range,
    text,
    rows: parsed.rows,
    aligns: parsed.aligns,
    hasHeader: true,
    linePrefixes: extractLinePrefixes(text),
    dirty: false,
  };
}

/**
 * 整表回读入口（P3）：把「当前位于编辑区的表格源码文本」（含行前缀）
 * 重新解析为 rows / aligns / hasHeader / linePrefixes——不含行区间定位，
 * 区间由调用方维护。writeBack 回写后立即调用，以解析结果覆盖内存矩阵
 *（源码为唯一事实源：修正 trim / 转义 / 反编译等解析器归一化差异）。
 * 解析失败（非表格文本）返回 null。
 */
export function parseTableSource(
  text: string,
  origin: TableOrigin,
): Pick<TableSource, "rows" | "aligns" | "hasHeader" | "linePrefixes" | "staticReason"> | null {
  if (origin === "html") {
    const parsed = parseHtmlTable(text);
    if (parsed.rows.length === 0) return null;
    return {
      rows: parsed.rows,
      aligns: parsed.aligns,
      hasHeader: parsed.hasHeader,
      linePrefixes: extractLinePrefixes(text),
      staticReason: parsed.staticReason,
    };
  }
  const parsed = parseMarkdownTable(text);
  if (parsed.rows.length === 0) return null;
  return {
    rows: parsed.rows,
    aligns: parsed.aligns,
    hasHeader: true,
    linePrefixes: extractLinePrefixes(text),
  };
}

/** 提交前校验：缓存的行区间是否仍指向缓存的源码文本（漂移检测） */
export function rangeMatches(lines: string[], range: LineRange, text: string): boolean {
  if (range.startLine < 1 || range.endLine > lines.length || range.startLine > range.endLine) return false;
  return lines.slice(range.startLine - 1, range.endLine).join("\n") === text;
}

/** 就近全文重定位：返回与旧位置最近的精确匹配区间（找不到返回 null） */
export function relocateNearest(doc: string, text: string, prevStart: number): LineRange | null {
  if (!text) return null;
  const lines = doc.split("\n");
  let best: { range: LineRange; dist: number } | null = null;
  let from = 0;
  for (;;) {
    const idx = doc.indexOf(text, from);
    if (idx === -1) break;
    const startLine = doc.slice(0, idx).split("\n").length;
    const range: LineRange = { startLine, endLine: startLine + text.split("\n").length - 1 };
    if (rangeMatches(lines, range, text)) {
      const dist = Math.abs(startLine - prevStart);
      if (!best || dist < best.dist) best = { range, dist };
      if (dist === 0) break;
    }
    from = idx + 1;
  }
  return best?.range ?? null;
}
