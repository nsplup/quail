/**
 * 回写一致性测试（P3 / P5）：
 * - 序列化 → 整表回读（parseTableSource）→ 再序列化 的幂等性
 *   （markdown / html 双来源）；
 * - 前缀保留：extractLinePrefix 的结构前缀语义（缩进 / 引用 / 列表标记）
 *   与 replaceLines(preservePrefix) 的逐行重组语义一致；
 * - 回读对齐：markdown 单元格的前导空白在回读时被归一化（trim），
 *   writeBack 后内存矩阵以源码为准。
 */
import { describe, expect, it } from "vitest";
import {
  emptyCell,
  extractLinePrefix,
  extractLinePrefixes,
  locateTableSource,
  markdownCell,
  parseTableSource,
  serializeMarkdownTable,
  serializeHtmlTable,
  type CellSource,
} from "../table-source";

describe("前缀提取（preservePrefix 的单一语义源）", () => {
  it("缩进 / 引用 / 列表标记 / 无前缀", () => {
    expect(extractLinePrefix("  | a |")).toBe("  ");
    expect(extractLinePrefix("> | a |")).toBe("> ");
    expect(extractLinePrefix("> > | a |")).toBe("> > ");
    expect(extractLinePrefix("- | a |")).toBe("- ");
    expect(extractLinePrefix("1. | a |")).toBe("1. ");
    expect(extractLinePrefix("| a |")).toBe("");
    expect(extractLinePrefix("<table>")).toBe("");
  });

  it("extractLinePrefixes 与文本行一一对应", () => {
    expect(extractLinePrefixes("  | a |\n| b |\n    </table>")).toEqual([
      "  ",
      "",
      "    ",
    ]);
  });

  it("locateTableSource：引用块内表格可定位（> 前缀剥离）", () => {
    const doc = "> | a | b |\n> | - | - |\n> | 1 | 2 |\n";
    const src = locateTableSource(doc, null, "markdown");
    expect(src).not.toBeNull();
    expect(src?.rows[0][0].raw).toBe("a");
    expect(src?.linePrefixes).toEqual(["> ", "> ", "> "]);
  });

  it("locateTableSource：tab 缩进的表格可定位（\\t 前缀）", () => {
    const doc = "\t| a | b |\n\t| - | - |\n\t| 1 | 2 |\n";
    const src = locateTableSource(doc, null, "markdown");
    expect(src).not.toBeNull();
    expect(src?.rows[0][0].raw).toBe("a");
    expect(src?.linePrefixes).toEqual(["\t", "\t", "\t"]);
  });

  it("前缀提取：tab 与 tab 混合形态", () => {
    expect(extractLinePrefix("\t| a |")).toBe("\t");
    expect(extractLinePrefix("\t\t| a |")).toBe("\t\t");
    expect(extractLinePrefix("  \t| a |")).toBe("  \t");
    expect(extractLinePrefix("-\t| a |")).toBe("-\t");
    expect(extractLinePrefix("1.\t| a |")).toBe("1.\t");
    expect(extractLinePrefix(">\t| a |")).toBe(">\t");
  });
});

describe("幂等：serialize → parseTableSource → serialize", () => {
  const mdRows: CellSource[][] = [
    [markdownCell("a"), markdownCell("b")],
    [markdownCell("c | d"), markdownCell("e")],
  ];

  it("markdown 来源（含转义管道与对齐）", () => {
    const first = serializeMarkdownTable(mdRows, [null, "left"]);
    const parsed = parseTableSource(first.text, "markdown");
    expect(parsed).not.toBeNull();
    expect(parsed?.rows[1][0].raw).toBe("c | d"); // \\| 转义回读还原
    const second = serializeMarkdownTable(parsed!.rows, parsed!.aligns);
    expect(second.text).toBe(first.text);
  });

  it("html 来源（表头 / 对齐 / 反编译单元格）", () => {
    const rows: CellSource[][] = [
      [markdownCell("h1"), markdownCell("h2")],
      [markdownCell("**b**"), markdownCell("a & b")],
    ];
    const first = serializeHtmlTable(rows, [null, "center"], true);
    const parsed = parseTableSource(first.text, "html");
    expect(parsed).not.toBeNull();
    expect(parsed?.staticReason).toBeUndefined();
    expect(parsed?.hasHeader).toBe(true);
    expect(parsed?.rows[1][0].raw).toBe("**b**");
    expect(parsed?.rows[1][1].raw).toBe("a & b");
    expect(parsed?.aligns[1]).toBe("center");
    const second = serializeHtmlTable(parsed!.rows, parsed!.aligns, parsed!.hasHeader);
    expect(second.text).toBe(first.text);
  });

  it("空表序列化稳定（html / markdown）", () => {
    const md = serializeMarkdownTable([[emptyCell(), emptyCell()]], []);
    expect(parseTableSource(md.text, "markdown")).not.toBeNull();
    const html = serializeHtmlTable([[emptyCell(), emptyCell()]], [], false);
    const parsed = parseTableSource(html.text, "html");
    const again = serializeHtmlTable(parsed!.rows, parsed!.aligns, parsed!.hasHeader);
    expect(again.text).toBe(html.text);
  });

  it("markdown 单元格换行 <br> ↔ \\n 互逆（回读还原换行）", () => {
    const ser = serializeMarkdownTable([[markdownCell("a\nb")]], []);
    expect(ser.text).toContain("a<br>b");
    const parsed = parseTableSource(ser.text, "markdown");
    expect(parsed?.rows[0][0].raw).toBe("a\nb");
  });

  it("markdown 单元格多行列表（用户报告用例）：序列化 → 回读 → 再序列化", () => {
    const first = serializeMarkdownTable(
      [[markdownCell("- a\n- b"), markdownCell("")]],
      [],
    );
    expect(first.text).toContain("- a<br>- b");
    const parsed = parseTableSource(first.text, "markdown");
    expect(parsed?.rows[0][0].raw).toBe("- a\n- b");
    const second = serializeMarkdownTable(parsed!.rows, parsed!.aligns);
    expect(second.text).toBe(first.text); // 幂等
  });
});

describe("回读对齐（源码为唯一事实源）", () => {
  it("markdown 单元格 '  text' → 回读归一化为 'text'", () => {
    const ser = serializeMarkdownTable(
      [[markdownCell("  text")], [markdownCell("b")]],
      [],
    );
    const parsed = parseTableSource(ser.text, "markdown");
    expect(parsed?.rows[0][0].raw).toBe("text");
  });

  it("html 单元格换行 <br> ↔ \\n 互逆（回读还原换行）", () => {
    const ser = serializeHtmlTable([[markdownCell("a\nb")]], [], false);
    expect(ser.text).toContain("a<br>b");
    const parsed = parseTableSource(ser.text, "html");
    expect(parsed?.rows[0][0].raw).toBe("a\nb");
  });
});

describe("定位与区间（含前缀上下文）", () => {
  it("locateTableSource：缩进列表内表格的区间 / text / linePrefixes", () => {
    const doc = "para\n\n- item\n  | a | b |\n  | -- | -- |\n  | c | d |\n";
    const src = locateTableSource(doc, null, "markdown");
    expect(src).not.toBeNull();
    expect(src?.startLine).toBe(4);
    expect(src?.endLine).toBe(6);
    expect(src?.text).toBe("  | a | b |\n  | -- | -- |\n  | c | d |");
    expect(src?.linePrefixes).toEqual(["  ", "  ", "  "]);
    expect(src?.rows[0][0].raw).toBe("a");
    expect(src?.dirty).toBe(false);
  });

  it("写回前缀保留语义：裸序列化行 + 现文档行前缀重组（模拟 replaceLines preservePrefix）", () => {
    const docLines = ["- item", "  | a | b |", "  | -- | -- |", "  | c | d |"];
    const ser = serializeMarkdownTable(
      [
        [markdownCell("x"), markdownCell("y")],
        [markdownCell("z"), markdownCell("w")],
      ],
      [null, null],
    );
    /* writeBack 传裸行 + preservePrefix：replaceLines 从现文档逐行取前缀 */
    const bare = ser.text.split("\n");
    const prefixes = docLines.slice(1).map(extractLinePrefix);
    const finalText = bare
      .map((l, i) => (prefixes[Math.min(i, prefixes.length - 1)] ?? "") + l)
      .join("\n");
    /* 前缀不丢：所有行仍带原缩进；内容区被序列化产物替换 */
    expect(finalText.split("\n").every((l) => l.startsWith("  "))).toBe(true);
    expect(finalText).not.toBe(docLines.slice(1).join("\n"));
  });
});
