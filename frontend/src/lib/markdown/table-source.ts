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
import type { Element as HastElement } from "hast";

export type TableOrigin = "markdown" | "html";
export type TableAlign = "left" | "center" | "right";

/** 表格源码定位 + 解析结果（rows[0] = 表头行；markdown 来源恒有表头） */
export interface TableSource {
  origin: TableOrigin;
  /** 表格在源码中的行区间（1-based，含端点） */
  startLine: number;
  endLine: number;
  /** 当前表格源码文本（行区间漂移校验 / 就近重定位的锚文本） */
  text: string;
  /** 原始单元格源（未渲染的 markdown / html 片段文本） */
  rows: string[][];
  /** 列对齐（来自 markdown 分隔行或 HTML align/text-align；null = 默认） */
  aligns: (TableAlign | null)[];
  /** 是否含表头行（HTML 来源可能纯 tbody） */
  hasHeader: boolean;
}

/* ---------------- 来源标记读取（与 markdown-core.ts 的标记约定对齐） ---------------- */

const MD_TABLE_FLAG = "data-md-table";
const HTML_TABLE_FLAG = "data-html-table";

function flagValue(el: HastElement, flag: string): unknown {
  const props = (el.properties ?? {}) as Record<string, unknown>;
  const camel = flag.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());
  return props[flag] ?? props[camel];
}

/** HAST table 元素 → 表格来源（缺标记时按 markdown 处理：GFM 表格是常态） */
export function tableOriginFromEl(el: HastElement): TableOrigin {
  if (flagValue(el, HTML_TABLE_FLAG)) return "html";
  return "markdown";
}

/** 单元格是否带合并（colspan/rowspan）——合并表格禁止反向编辑，避免破坏结构 */
export function hasSpanCells(el: HastElement): boolean {
  return collectRows(el).some((row) =>
    row.cells.some((c) => {
      const p = c.properties ?? {};
      const span = (k: string) => {
        const v = p[k] ?? p[k[0].toUpperCase() + k.slice(1)];
        return v != null && String(v) !== "1";
      };
      return span("colspan") || span("rowspan");
    })
  );
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
function markdownRowCells(line: string): string[] {
  let t = line.trim();
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

/** markdown 表格源码文本 → 行矩阵 + 对齐（rows[0] = 表头） */
function parseMarkdownTable(text: string): { rows: string[][]; aligns: (TableAlign | null)[] } {
  const lines = text.split("\n");
  const rows: string[][] = [];
  let aligns: (TableAlign | null)[] = [];
  lines.forEach((line, i) => {
    if (i === 1) {
      // 分隔行：不进入内容矩阵，只取列对齐
      const first = markdownRowCells(lines[0]);
      aligns = parseAlignsFromDelimiter(line, first.length);
      return;
    }
    rows.push(markdownRowCells(line));
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

/** HTML 表格源码文本 → 行矩阵 + 对齐 + 表头判定（DOMParser 解析） */
function parseHtmlTable(text: string): { rows: string[][]; aligns: (TableAlign | null)[]; hasHeader: boolean } {
  const doc = new DOMParser().parseFromString(text, "text/html");
  const table = doc.body.querySelector("table");
  if (!table) return { rows: [[]], aligns: [], hasHeader: false };
  const rows: string[][] = [];
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
        rows.push(cells.map((c) => c.text));
        /* 列对齐取自首个收集到的行（thead 行或首行），与序列化写回一致 */
        if (!alignsFilled) {
          aligns = cells.map((c) => c.align);
          alignsFilled = true;
        }
      }
    } else if (tag === "tr") {
      const cells = domRowCells(section);
      rows.push(cells.map((c) => c.text));
      if (!alignsFilled) {
        aligns = cells.map((c) => c.align);
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
  return { rows, aligns, hasHeader };
}

/** 收集一个 <tr> 的直接子级单元格（文本 + 对齐） */
function domRowCells(tr: Element): { text: string; align: TableAlign | null }[] {
  return Array.from(tr.children)
    .filter((el) => ["td", "th"].includes((el.tagName || "").toLowerCase()))
    .map((el) => {
      const he = el as HTMLElement;
      // textContent 保留源码换行（序列化时转 <br>，解析时还原，互逆）
      const text = (he.textContent ?? "").replace(/\n+$/s, "").trim();
      let align: TableAlign | null = null;
      const a = (he.getAttribute("align") ?? "").toLowerCase();
      if (a === "left" || a === "center" || a === "right") {
        align = a;
      } else {
        const m = /text-align\s*:\s*(left|center|right)/i.exec(he.getAttribute("style") ?? "");
        if (m) align = m[1].toLowerCase() as TableAlign;
      }
      return { text, align };
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
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

/** rows → 对齐填充的 GFM 表格源码（rows[0] = 表头；恒输出分隔行） */
export function serializeMarkdownTable(rows: string[][], aligns: (TableAlign | null)[]): string {
  const colCount = Math.max(1, ...rows.map((r) => r.length), aligns.length);
  const norm = rows.map((r) => {
    const cells = [...r];
    while (cells.length < colCount) cells.push("");
    return cells.map(escapeMarkdownCell);
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
  return [lines[0] ?? "", delim, ...lines.slice(1)].join("\n");
}

function escapeHtmlCell(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r?\n/g, "<br>");
}

/** rows → 缩进规整的 HTML 表格源码（2 空格缩进；hasHeader 时输出 thead/th） */
export function serializeHtmlTable(
  rows: string[][],
  aligns: (TableAlign | null)[],
  hasHeader: boolean
): string {
  const colCount = Math.max(1, ...rows.map((r) => r.length));
  const norm = rows.map((r) => {
    const cells = [...r];
    while (cells.length < colCount) cells.push("");
    return cells;
  });
  const alignAttr = (c: number): string => {
    const a = aligns[c];
    return a && a !== "left" ? ` align="${a}"` : "";
  };
  const out: string[] = ["<table>"];
  const emitRow = (cells: string[], tag: "th" | "td", indent: string): void => {
    out.push(`${indent}<tr>`);
    cells.forEach((cell, c) => {
      out.push(`${indent}  <${tag}${alignAttr(c)}>${escapeHtmlCell(cell)}</${tag}>`);
    });
    out.push(`${indent}</tr>`);
  };
  if (hasHeader && norm.length > 0) {
    out.push("  <thead>");
    emitRow(norm[0], "th", "    ");
    out.push("  </thead>");
    if (norm.length > 1) {
      out.push("  <tbody>");
      norm.slice(1).forEach((r) => emitRow(r, "td", "    "));
      out.push("  </tbody>");
    }
  } else {
    out.push("  <tbody>");
    norm.forEach((r) => emitRow(r, "td", "    "));
    out.push("  </tbody>");
  }
  out.push("</table>");
  return out.join("\n");
}

/** 底栏插入用：r 行 c 列的格式化 MARKDOWN 表格（空表头 + 空单元格） */
export function emptyMarkdownTable(rowCount: number, colCount: number): string {
  const rows: string[][] = Array.from({ length: Math.max(1, rowCount) }, () => new Array(colCount).fill(""));
  return serializeMarkdownTable(rows, []);
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
    return { origin, ...range, text, rows: parsed.rows, aligns: parsed.aligns, hasHeader: parsed.hasHeader };
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
