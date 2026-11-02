/**
 * 引用块内多表格定位测试（块内序号 data-table-ordinal 修复）：
 *
 * - extractAllMarkdownTableRanges / extractAllHtmlTableRanges：枚举区间内
 *   全部表格（含引用块 `>` 前缀、嵌套 HTML 表格、未闭合边界）——取代
 *   "命中第一个就返回"的旧语义；
 * - locateTableSource(..., tableOrdinal)：seed 内按块内序号选表；
 *   seed 内无表（全文兜底）或序号越界 → 回退第一个（保守 + 向后兼容）；
 * - annotateTableOrdinals（通过 compileMarkdown 端到端验证）：每个顶层块
 *   的表格按出现序从 0 编号（锚 comment 重置计数）；嵌套表格不参与计数；
 *   markdown 与 raw HTML 表格统一编号。
 *
 * 依赖：本测试假设 table-source.ts / markdown-core.ts 已按修复方案改造，
 * 即：
 *   - export extractAllMarkdownTableRanges / extractAllHtmlTableRanges
 *   - locateTableSource 增加可选参数 tableOrdinal: number | null
 *   - mdastToHastRaw 末尾（markHtmlTables 之后、stripHastPosition 之前）
 *     调用 annotateTableOrdinals(sanitized)
 */
import { describe, expect, it } from "vitest";
import type {
  Element as HastElement,
  RootContent,
  Root as HastRoot,
} from "hast";
import {
  extractAllHtmlTableRanges,
  extractAllMarkdownTableRanges,
  locateTableSource,
} from "../table-source";
import { compileMarkdown } from "../markdown-core";

/* ============================================================
 * 1. 枚举：返回区间内全部表格（不再"命中第一个就返回"）
 * ============================================================ */

describe("extractAllMarkdownTableRanges", () => {
  it("单表：返回一个区间", () => {
    const lines = ["| a | b |", "| - | - |", "| 1 | 2 |"];
    expect(extractAllMarkdownTableRanges(lines)).toEqual([
      { start: 0, end: 2 },
    ]);
  });

  it("引用块内两张表（> 前缀）：返回两个独立区间", () => {
    const lines = [
      "> | a | b |",
      "> | - | - |",
      "> | 1 | 2 |",
      ">",
      "> | c | d |",
      "> | - | - |",
      "> | 3 | 4 |",
    ];
    expect(extractAllMarkdownTableRanges(lines)).toEqual([
      { start: 0, end: 2 },
      { start: 4, end: 6 },
    ]);
  });

  it("两表之间有空行：不粘连", () => {
    const lines = [
      "| a |",
      "| - |",
      "| 1 |",
      "",
      "| b |",
      "| - |",
      "| 2 |",
    ];
    expect(extractAllMarkdownTableRanges(lines)).toEqual([
      { start: 0, end: 2 },
      { start: 4, end: 6 },
    ]);
  });

  it("无表：返回空数组", () => {
    expect(extractAllMarkdownTableRanges(["hello", "", "world"])).toEqual([]);
  });

  it("仅表头 + 分隔行（无表体）：仍识别为单表", () => {
    expect(
      extractAllMarkdownTableRanges(["| a | b |", "| - | - |"]),
    ).toEqual([{ start: 0, end: 1 }]);
  });
});

describe("extractAllHtmlTableRanges", () => {
  it("单表（跨行）", () => {
    const lines = ["<table>", "  <tr><td>a</td></tr>", "</table>"];
    expect(extractAllHtmlTableRanges(lines)).toEqual([{ start: 0, end: 2 }]);
  });

  it("并列两张表", () => {
    const lines = [
      "<table><tr><td>a</td></tr></table>",
      "",
      "<table><tr><td>b</td></tr></table>",
    ];
    expect(extractAllHtmlTableRanges(lines)).toEqual([
      { start: 0, end: 0 },
      { start: 2, end: 2 },
    ]);
  });

  it("嵌套表：外层包含内层，只返回一个区间", () => {
    const lines = [
      "<table>",
      "  <tr><td>",
      "    <table><tr><td>inner</td></tr></table>",
      "  </td></tr>",
      "</table>",
    ];
    expect(extractAllHtmlTableRanges(lines)).toEqual([{ start: 0, end: 4 }]);
  });

  it("未闭合：终止枚举，不返回半截区间", () => {
    expect(
      extractAllHtmlTableRanges(["<table>", "  <tr><td>a</td></tr>"]),
    ).toEqual([]);
  });
});

/* ============================================================
 * 2. locateTableSource(..., tableOrdinal)：块内序号选择
 * ============================================================ */

describe("locateTableSource：块内序号", () => {
  /* 文档布局：
   *   1..7  引用块（含两张 markdown 表，1..3 / 5..7）
   *   8     空行
   *   9..11 顶层表（x | y）
   */
  const doc = [
    "> | a | b |",
    "> | - | - |",
    "> | 1 | 2 |",
    ">",
    "> | c | d |",
    "> | - | - |",
    "> | 3 | 4 |",
    "",
    "| x | y |",
    "| - | - |",
    "| 5 | 6 |",
  ].join("\n");

  /** 引用块行区间（1-based，含端点） */
  const seed = { startLine: 1, endLine: 7 };

  it("序号 0 → 第一张表（表头 a/b，表体 1/2）", () => {
    const src = locateTableSource(doc, seed, "markdown", 0);
    expect(src).not.toBeNull();
    expect(src?.startLine).toBe(1);
    expect(src?.endLine).toBe(3);
    expect(src?.rows[0][0].raw).toBe("a");
    expect(src?.rows[0][1].raw).toBe("b");
    expect(src?.rows[1][0].raw).toBe("1");
  });

  it("序号 1 → 第二张表（表头 c/d，表体 3/4）", () => {
    const src = locateTableSource(doc, seed, "markdown", 1);
    expect(src).not.toBeNull();
    expect(src?.startLine).toBe(5);
    expect(src?.endLine).toBe(7);
    expect(src?.rows[0][0].raw).toBe("c");
    expect(src?.rows[0][1].raw).toBe("d");
    expect(src?.rows[1][0].raw).toBe("3");
  });

  it("不传 tableOrdinal → 回退第一个（向后兼容）", () => {
    const src = locateTableSource(doc, seed, "markdown");
    expect(src?.startLine).toBe(1);
    expect(src?.rows[0][0].raw).toBe("a");
  });

  it("序号越界（>= seed 内表数）→ 回退 seed 内第一个（保守，不写到别的表）", () => {
    const src = locateTableSource(doc, seed, "markdown", 99);
    expect(src?.startLine).toBe(1);
    expect(src?.rows[0][0].raw).toBe("a");
  });

  it("seed 内无表（空行）→ 全文兜底，忽略 tableOrdinal（取全文第一张）", () => {
    const emptySeed = { startLine: 8, endLine: 8 };
    const src = locateTableSource(doc, emptySeed, "markdown", 1);
    /* 全文兜底是全文第 1 张（引用块内第 1 张），而非块内序号 1（引用块内第 2 张） */
    expect(src).not.toBeNull();
    expect(src?.startLine).toBe(1);
    expect(src?.rows[0][0].raw).toBe("a");
  });

  it("顶层两张表（不同块）：各自 seed 内序号 0 命中各自的表", () => {
    /* 顶层表分属不同块：EditableTable 对每张表各自传 tableOrdinal = 0 */
    const block1Seed = { startLine: 9, endLine: 11 };
    const s1 = locateTableSource(doc, block1Seed, "markdown", 0);
    expect(s1?.startLine).toBe(9);
    expect(s1?.rows[0][0].raw).toBe("x");
  });

  it("HTML 来源：两张表按块内序号选（引用块前缀下同样可定位）", () => {
    const htmlDoc = [
      "> <table>",
      ">   <tr><td>a</td></tr>",
      "> </table>",
      ">",
      "> <table>",
      ">   <tr><td>b</td></tr>",
      "> </table>",
    ].join("\n");
    const htmlSeed = { startLine: 1, endLine: 7 };

    const s0 = locateTableSource(htmlDoc, htmlSeed, "html", 0);
    expect(s0).not.toBeNull();
    expect(s0?.startLine).toBe(1);
    expect(s0?.endLine).toBe(3);
    expect(s0?.rows[0][0].raw).toBe("a");

    const s1 = locateTableSource(htmlDoc, htmlSeed, "html", 1);
    expect(s1).not.toBeNull();
    expect(s1?.startLine).toBe(5);
    expect(s1?.endLine).toBe(7);
    expect(s1?.rows[0][0].raw).toBe("b");
  });
});

/* ============================================================
 * 3. annotateTableOrdinals（通过 compileMarkdown 端到端验证）
 * ============================================================ */

/** 遍历 HAST 收集所有 table 的 data-table-ordinal（null = 未标注） */
function allTableOrdinals(root: HastRoot): (string | null)[] {
  const out: (string | null)[] = [];
  const walk = (n: RootContent): void => {
    if (n.type !== "element") return;          // Doctype / Text / Comment 都会被跳过
    const el = n as HastElement;               // 其实这里 n 已窄化为 Element，可省
    if (el.tagName === "table") {
      const p = (el.properties ?? {}) as Record<string, unknown>;
      const v = p["data-table-ordinal"] ?? p.dataTableOrdinal;
      out.push(v == null ? null : String(v));
      // 继续递归：验证嵌套表格不参与计数（inner 应为 null）
    }
    for (const c of el.children) walk(c);      // ElementContent ⊆ RootContent，OK
  };
  for (const c of root.children) walk(c);      // ✅ 类型匹配
  return out;
}

describe("annotateTableOrdinals：块内表格序号", () => {
  it("引用块内两张 markdown 表：同一块内序号 0、1", () => {
    const src = [
      "> | a | b |",
      "> | - | - |",
      "> | 1 | 2 |",
      ">",
      "> | c | d |",
      "> | - | - |",
      "> | 3 | 4 |",
    ].join("\n");
    expect(allTableOrdinals(compileMarkdown(src))).toEqual(["0", "1"]);
  });

  it("顶层两张表（各自独立块）：每块内序号均为 0（锚 comment 重置）", () => {
    const src = ["| a |", "| - |", "| 1 |", "", "| b |", "| - |", "| 2 |"].join(
      "\n",
    );
    expect(allTableOrdinals(compileMarkdown(src))).toEqual(["0", "0"]);
  });

  it("同一块内 markdown + raw HTML 混合：统一按出现顺序编号", () => {
    const src = [
      "> | a |",
      "> | - |",
      "> | 1 |",
      ">",
      "> <table>",
      ">   <tr><td>x</td></tr>",
      "> </table>",
    ].join("\n");
    expect(allTableOrdinals(compileMarkdown(src))).toEqual(["0", "1"]);
  });

  it("HTML 单元格内嵌套表格：外层序号 0，内层不参与计数（null）", () => {
    const src = [
      "<table>",
      "  <tr><td>",
      "    <table><tr><td>inner</td></tr></table>",
      "  </td></tr>",
      "</table>",
    ].join("\n");
    /* 外层表格 data-table-ordinal = "0"；内层表格未被标注（遍历遇外层 table
     * 即 return，不递归）——与外层 extractAllHtmlTableRanges「包含内层，不
     * 单独枚举」语义一致 */
    expect(allTableOrdinals(compileMarkdown(src))).toEqual(["0", null]);
  });

  it("列表项内表格（块内首表）：序号 0", () => {
    const src = ["- item", "  | a |", "  | - |", "  | 1 |"].join("\n");
    expect(allTableOrdinals(compileMarkdown(src))).toEqual(["0"]);
  });

  it("非表格内容不受影响（空文档 / 纯段落）", () => {
    expect(allTableOrdinals(compileMarkdown(""))).toEqual([]);
    expect(allTableOrdinals(compileMarkdown("hello\n\nworld"))).toEqual([]);
  });
});