/**
 * 可编辑表格 Codec 属性测试（P2 / P5）：
 * - 单元格 markdown inline ↔ HTML 片段双向可逆
 *   （decodeCell(encodeCell(x)) === x，含 <br> / 实体 / 首尾空格）；
 * - HTML 来源单元格语言统一（P4）：已知标签反编译为 markdown；未知标签
 *   / 白名单外结构 → lang 停留 "html"，parseTableSource 报告整表静态。
 */
import { describe, expect, it } from "vitest";
import {
  assertRoundTrip,
  decodeCell,
  emptyCell,
  encodeCell,
  parseTableSource,
  type CellSource,
} from "../table-source";

describe("table codec：markdown ↔ html 单元格可逆编解码", () => {
  const samples = [
    "a\nb",
    "**bold**",
    "a|b",
    "  indented",
    "*em*",
    "`code`",
    "a & b",
  ];

  it.each(samples)("round-trip（html 来源）：%j", (s) => {
    expect(assertRoundTrip(s, "html")).toBe(true);
  });

  it.each(samples)("round-trip（markdown 来源）恒等：%j", (s) => {
    expect(assertRoundTrip(s, "markdown")).toBe(true);
  });

  it("<strong> 反编译为 **；encode 再编译回 <strong>", () => {
    const c: CellSource = { ...emptyCell(), raw: "<strong>bold</strong>", lang: "html" };
    expect(decodeCell(c)).toBe("**bold**");
    expect(c.lang).toBe("markdown");
    expect(encodeCell("**bold**", "html")).toBe("<strong>bold</strong>");
  });

  it("嵌套内联（<strong><em>）反编译为 ***", () => {
    const c: CellSource = { ...emptyCell(), raw: "<strong><em>x</em></strong>", lang: "html" };
    expect(decodeCell(c)).toBe("***x***");
  });

  it("<div> 等未知标签 → 保持 lang=html 并返回原始 HTML", () => {
    const raw = "<div>x</div>";
    const c: CellSource = { ...emptyCell(), raw, lang: "html" };
    expect(decodeCell(c)).toBe(raw);
    expect(c.lang).toBe("html");
  });

  it("<br> 与 &nbsp; 的显式解码（不依赖 textContent 的隐式行为）", () => {
    const br: CellSource = { ...emptyCell(), raw: "a<br>b", lang: "html" };
    expect(decodeCell(br)).toBe("a\nb");
    const nbsp: CellSource = { ...emptyCell(), raw: "&nbsp;x", lang: "html" };
    expect(decodeCell(nbsp)).toBe(" x");
  });

  it("decodeCell 幂等（markdown 单元格原样返回，不重复处理）", () => {
    const c: CellSource = { ...emptyCell(), raw: "**b**", lang: "markdown" };
    expect(decodeCell(c)).toBe("**b**");
    expect(decodeCell(c)).toBe("**b**");
  });

  it("encode（html）首尾空格以 &#32; 补回（markdown 编译剥离的逆操作）", () => {
    expect(encodeCell("  indented", "html")).toBe("&#32;&#32;indented");
    expect(encodeCell("trailing  ", "html")).toBe("trailing&#32;&#32;");
  });

  it("encode（html）换行显式转 <br>（soft break → 块级结构不外泄）", () => {
    expect(encodeCell("a\nb", "html")).toBe("a<br>b");
  });

  it("encode（markdown）原样返回（转义由 serializeMarkdownTable 处理）", () => {
    expect(encodeCell("a|b\n**x**", "markdown")).toBe("a|b\n**x**");
  });
});

describe("table codec：HTML 表格来源语言统一（P4）", () => {
  it("含 <strong> 的 HTML 表 → 单元格反编译为 markdown，不静态", () => {
    const parsed = parseTableSource(
      "<table><thead><tr><th>a</th></tr></thead><tbody><tr><td><strong>b</strong></td></tr></tbody></table>",
      "html",
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.staticReason).toBeUndefined();
    expect(parsed?.rows[1][0].raw).toBe("**b**");
    expect(parsed?.rows[1][0].lang).toBe("markdown");
  });

  it("含 <div> 的 HTML 表 → 整表静态（staticReason = attrs）", () => {
    const parsed = parseTableSource(
      "<table><tbody><tr><td><div>x</div></td></tr></tbody></table>",
      "html",
    );
    expect(parsed?.staticReason).toBe("attrs");
  });

  it("含白名单外属性（class）的单元格 → 整表静态", () => {
    const parsed = parseTableSource(
      '<table><tbody><tr><td class="x">plain</td></tr></tbody></table>',
      "html",
    );
    expect(parsed?.staticReason).toBe("attrs");
  });

  it("白名单内属性（align/style/data-*）→ 不静态且保留在 attrs", () => {
    const parsed = parseTableSource(
      '<table><tbody><tr><td align="center" style="text-align: center" data-x="1">a</td></tr></tbody></table>',
      "html",
    );
    expect(parsed?.staticReason).toBeUndefined();
    expect(parsed?.rows[0][0].attrs).toEqual({
      align: "center",
      style: "text-align: center",
      "data-x": "1",
    });
    expect(parsed?.aligns[0]).toBe("center");
  });
});
