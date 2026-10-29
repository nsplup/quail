/**
 * HTML 表格源码前缀测试（writeBack 缩进不累积 + cellOffset 正确性）：
 *
 * - outerPrefix（HTML 特有）：序列化时一次性生成「外部上下文前缀 + 内部
 *   结构缩进」，避免 replaceLines(preservePrefix=true) 把上一轮产物里的
 *   结构缩进当外部前缀再叠一层 → 无限缩进。
 * - cellOffset：指向锚定单元格内容首字符。历史版本少算 "<" 一字符
 *   （off-by-one），此处回归覆盖。
 * - markdown 路径（preservePrefix=true）作为对照：前缀取自现文档，多次
 *   回写不累积。
 *
 * 模拟 replaceLines(preservePrefix) 的语义来自现有回写测试的约定：
 * 现文档逐行取前缀拼在新行前；新行数 > 旧行数时，多出的行沿用最后
 * 一个前缀。
 */
import { describe, expect, it } from "vitest";
import {
  emptyCell,
  extractLinePrefix,
  markdownCell,
  parseTableSource,
  serializeHtmlTable,
  serializeMarkdownTable,
  type CellSource,
} from "../table-source";

/* ---------------- 模拟 replaceLines(preservePrefix) ---------------- */

/**
 * 复刻 EditorApi.replaceLines 的 preservePrefix 行为（范围替换 + 前缀拼接）。
 * 用于在纯函数测试里模拟 writeBack 的完整流程。
 */
function simulateReplaceLines(
  doc: string,
  startLine: number,
  endLine: number,
  newText: string,
  preservePrefix: boolean,
): string {
  const lines = doc.split("\n");
  const newLines = newText.split("\n");
  const oldPrefixes = lines
    .slice(startLine - 1, endLine)
    .map(extractLinePrefix);
  const finalLines = newLines.map((l, i) =>
    preservePrefix
      ? (oldPrefixes[Math.min(i, oldPrefixes.length - 1)] ?? "") + l
      : l,
  );
  return [
    ...lines.slice(0, startLine - 1),
    ...finalLines,
    ...lines.slice(endLine),
  ].join("\n");
}

/* ---------------- outerPrefix 向后兼容 ---------------- */

describe("serializeHtmlTable：outerPrefix 默认值（向后兼容）", () => {
  it("outerPrefix 缺省时输出与旧版逐字符一致", () => {
    const rows: CellSource[][] = [
      [markdownCell("a"), markdownCell("b")],
      [markdownCell("c"), markdownCell("d")],
    ];
    const { text } = serializeHtmlTable(rows, [], true);
    expect(text).toBe(
      [
        "<table>",
        "  <thead>",
        "    <tr>",
        "      <th>a</th>",
        "      <th>b</th>",
        "    </tr>",
        "  </thead>",
        "  <tbody>",
        "    <tr>",
        "      <td>c</td>",
        "      <td>d</td>",
        "    </tr>",
        "  </tbody>",
        "</table>",
      ].join("\n"),
    );
  });

  it("默认 outerPrefix 在无表头场景也一致", () => {
    const rows: CellSource[][] = [[markdownCell("x")]];
    const { text } = serializeHtmlTable(rows, [], false);
    expect(text).toBe(
      [
        "<table>",
        "  <tbody>",
        "    <tr>",
        "      <td>x</td>",
        "    </tr>",
        "  </tbody>",
        "</table>",
      ].join("\n"),
    );
  });
});

/* ---------------- outerPrefix 逐行注入 ---------------- */

describe("serializeHtmlTable：outerPrefix 逐行注入", () => {
  it("每行（含 <table> / </table>）都带列表内容层缩进", () => {
    const rows: CellSource[][] = [[markdownCell("a")]];
    const { text } = serializeHtmlTable(rows, [], false, undefined, "  ");
    const lines = text.split("\n");
    expect(lines.every((l) => l.startsWith("  "))).toBe(true);
    expect(lines[0]).toBe("  <table>");
    expect(lines[lines.length - 1]).toBe("  </table>");
  });

  it("引用块（> ）逐行保留引用标记", () => {
    const rows: CellSource[][] = [[markdownCell("a")]];
    const { text } = serializeHtmlTable(rows, [], false, undefined, "> ");
    const lines = text.split("\n");
    expect(lines.every((l) => l.startsWith("> "))).toBe(true);
  });

  it("引用 + 列表混合前缀（>   ）", () => {
    const rows: CellSource[][] = [[markdownCell("a")]];
    const { text } = serializeHtmlTable(rows, [], false, undefined, ">   ");
    expect(text.split("\n").every((l) => l.startsWith(">   "))).toBe(true);
  });

  it("outerPrefix 不影响内部结构缩进的相对层级", () => {
    const rows: CellSource[][] = [
      [markdownCell("h")],
      [markdownCell("d")],
    ];
    const { text } = serializeHtmlTable(rows, [], true, undefined, "  ");
    const lines = text.split("\n");
    // <table> = 外部 2，<thead> = 外部 + 2，<tr> = 外部 + 4，<th> = 外部 + 6
    expect(lines[0]).toMatch(/^ {2}<table>$/);
    expect(lines[1]).toMatch(/^ {4}<thead>$/);
    expect(lines[2]).toMatch(/^ {6}<tr>$/);
    expect(lines[3]).toMatch(/^ {8}<th>/);
  });
});

/* ---------------- 多次回写不累积（writeBack 模拟） ---------------- */

describe("writeBack 模拟：多次回写前缀不累积", () => {
  it("HTML 表格：连续 5 次回写缩进稳定（本次修复）", () => {
    const original = [
      "- item",
      "  <table>",
      "    <tbody>",
      "      <tr>",
      "        <td>a</td>",
      "      </tr>",
      "    </tbody>",
      "  </table>",
    ].join("\n");

    const rows: CellSource[][] = [[markdownCell("b")]];
    let doc = original;
    const startLine = 2;
    let endLine = 8;

    for (let i = 0; i < 5; i++) {
      const linePrefixes = doc
        .split("\n")
        .slice(startLine - 1, endLine)
        .map(extractLinePrefix);
      const outerPrefix = linePrefixes[0] ?? "";
      const ser = serializeHtmlTable(rows, [], false, undefined, outerPrefix);
      doc = simulateReplaceLines(doc, startLine, endLine, ser.text, false);
      endLine = startLine + ser.text.split("\n").length - 1;
    }

    const lines = doc.split("\n");
    // 第 2 行仍带 "  " 前缀；结构缩进未叠加
    expect(lines[1]).toBe("  <table>");
    // 全文档没有一行出现「超过两层的列表前缀」形态
    expect(lines.filter((l) => l.startsWith("    <table>")).length).toBe(0);
    // 总行数稳定
    expect(lines.length).toBe(8);
  });

  it("HTML 表格：多次回写后再次回写输出与首次回写文本一致（结构幂等）", () => {
    const original = [
      "- item",
      "  <table>",
      "    <tbody>",
      "      <tr>",
      "        <td>x</td>",
      "      </tr>",
      "    </tbody>",
      "  </table>",
    ].join("\n");

    const rows: CellSource[][] = [[markdownCell("x")]];
    let doc = original;
    let prevRangeText = "";
    const startLine = 2;
    let endLine = 8;

    for (let i = 0; i < 3; i++) {
      const linePrefixes = doc
        .split("\n")
        .slice(startLine - 1, endLine)
        .map(extractLinePrefix);
      const ser = serializeHtmlTable(rows, [], false, undefined, linePrefixes[0] ?? "");
      doc = simulateReplaceLines(doc, startLine, endLine, ser.text, false);
      endLine = startLine + ser.text.split("\n").length - 1;
      const rangeText = doc
        .split("\n")
        .slice(startLine - 1, endLine)
        .join("\n");
      if (i > 0) {
        expect(rangeText).toBe(prevRangeText);
      }
      prevRangeText = rangeText;
    }
  });

  it("Markdown 表格（对照）：preservePrefix=true 多次回写不累积", () => {
    const original = [
      "- item",
      "  | a | b |",
      "  | - | - |",
      "  | c | d |",
    ].join("\n");

    /* 用 3 字符内容：列宽 = max(3, 内容宽) = 3，不触发对齐 padding，
       输出格式可精确断言（1-2 字符内容会被 padCell 补到 3 宽，
       断言需按填充后结果写，可读性差且偏离测试意图） */
    const rows: CellSource[][] = [
      [markdownCell("xxx"), markdownCell("yyy")],
      [markdownCell("zzz"), markdownCell("www")],
    ];
    const startLine = 2;
    const endLine = 4;

    let doc = original;
    for (let i = 0; i < 5; i++) {
      const ser = serializeMarkdownTable(rows, []);
      doc = simulateReplaceLines(doc, startLine, endLine, ser.text, true);
    }

    const lines = doc.split("\n");
    // 内容被正确替换（前缀 "  " + 裸行）
    expect(lines[1]).toBe("  | xxx | yyy |");
    expect(lines[2]).toMatch(/^  \|[-: ]+\|[-: ]+\|$/);
    expect(lines[3]).toBe("  | zzz | www |");
    // 核心意图：前缀不累积——每行仍是 2 空格前缀，没有变成 4+ 空格
    expect(lines.slice(1).every((l) => !l.startsWith("    "))).toBe(true);
  });
});

/* ---------------- cellOffset 正确性（覆盖 off-by-one） ---------------- */

describe("serializeHtmlTable：cellOffset 指向单元格内容首字符", () => {
  it("body 行第二个单元格（无 outerPrefix）", () => {
    const rows: CellSource[][] = [
      [markdownCell("hello"), markdownCell("world")],
    ];
    const { text, cellOffset } = serializeHtmlTable(rows, [], false, {
      r: 0,
      c: 1,
    });
    expect(text.slice(cellOffset, cellOffset + 5)).toBe("world");
    // 修复前会指向 ">"（off-by-one）
    expect(text[cellOffset]).toBe("w");
  });

  it("thead 表头第一个单元格", () => {
    const rows: CellSource[][] = [
      [markdownCell("h1"), markdownCell("h2")],
      [markdownCell("d1"), markdownCell("d2")],
    ];
    const { text, cellOffset } = serializeHtmlTable(rows, [], true, {
      r: 0,
      c: 0,
    });
    expect(text.slice(cellOffset, cellOffset + 2)).toBe("h1");
  });

  it("thead 的第二个单元格（跨 header + body 场景）", () => {
    const rows: CellSource[][] = [
      [markdownCell("h1"), markdownCell("h2")],
      [markdownCell("d1"), markdownCell("d2")],
    ];
    const { text, cellOffset } = serializeHtmlTable(rows, [], true, {
      r: 0,
      c: 1,
    });
    expect(text.slice(cellOffset, cellOffset + 2)).toBe("h2");
  });

  it("body 中间行、中间单元格", () => {
    const rows: CellSource[][] = [
      [markdownCell("h1"), markdownCell("h2")],
      [markdownCell("a"), markdownCell("b")],
      [markdownCell("c"), markdownCell("d")],
    ];
    const { text, cellOffset } = serializeHtmlTable(rows, [], true, {
      r: 2,
      c: 1,
    });
    expect(text.slice(cellOffset, cellOffset + 1)).toBe("d");
  });

  it("带 attrs 的单元格（cellOffset 要跨过 attrs 长度）", () => {
    const cell: CellSource = {
      raw: "cell",
      lang: "markdown",
      spans: { colspan: 1, rowspan: 1 },
      attrs: { style: "color: red" },
    };
    const { text, cellOffset } = serializeHtmlTable(
      [[cell]],
      ["left"],
      false,
      { r: 0, c: 0 },
    );
    expect(text.slice(cellOffset, cellOffset + 4)).toBe("cell");
  });

  it("outerPrefix 计入 cellOffset（引用块场景）", () => {
    const rows: CellSource[][] = [
      [markdownCell("a"), markdownCell("b")],
    ];
    const { text, cellOffset } = serializeHtmlTable(
      rows,
      [],
      false,
      { r: 0, c: 1 },
      "> ",
    );
    expect(text.slice(cellOffset, cellOffset + 1)).toBe("b");
    expect(text[cellOffset - 1]).toBe(">"); // 内容前一字符是 ">"
    expect(text[cellOffset - 2]).toBe("d"); // 再前是 td 的 "d"
  });

  it("hasHeader=true 且只有表头（无 tbody）：cellOffset 仍正确", () => {
    const rows: CellSource[][] = [[markdownCell("only")]];
    const { text, cellOffset } = serializeHtmlTable(rows, [], true, {
      r: 0,
      c: 0,
    });
    expect(text).not.toContain("<tbody>");
    expect(text.slice(cellOffset, cellOffset + 4)).toBe("only");
  });

  it("空单元格也能定位（偏移指向 > 之后）", () => {
    const rows: CellSource[][] = [
      [markdownCell("a"), emptyCell()],
    ];
    const { text, cellOffset } = serializeHtmlTable(rows, [], false, {
      r: 0,
      c: 1,
    });
    // 空内容：锚点是 ">" 之后的位置
    expect(text[cellOffset - 1]).toBe(">");
    expect(text[cellOffset]).toBe("<"); // 紧跟 </td> 的 "<"
  });

  it("未传 mark 时 cellOffset 恒为 0", () => {
    const rows: CellSource[][] = [[markdownCell("x")]];
    const { cellOffset } = serializeHtmlTable(rows, [], false);
    expect(cellOffset).toBe(0);
  });

  it("mark.r 越界时 cellOffset 回落 0", () => {
    const rows: CellSource[][] = [[markdownCell("x")]];
    const { cellOffset } = serializeHtmlTable(rows, [], false, {
      r: 99,
      c: 0,
    });
    expect(cellOffset).toBe(0);
  });
});

/* ---------------- 端到端：writeBack 后回读 cellOffset 仍有效 ---------------- */

describe("cellOffset + outerPrefix：写回后回读一致性", () => {
  it("回写后新文档的 cellOffset 位置仍指向单元格内容（链式校验）", () => {
    const original = [
      "- item",
      "  <table>",
      "    <tbody>",
      "      <tr>",
      "        <td>old</td>",
      "      </tr>",
      "    </tbody>",
      "  </table>",
    ].join("\n");

    const startLine = 2;
    let endLine = 8;
    const rows: CellSource[][] = [[markdownCell("new")]];
    const linePrefixes = original
      .split("\n")
      .slice(startLine - 1, endLine)
      .map(extractLinePrefix);
    const outerPrefix = linePrefixes[0] ?? "";

    const ser = serializeHtmlTable(
      rows,
      [],
      false,
      { r: 0, c: 0 },
      outerPrefix,
    );
    const after = simulateReplaceLines(original, startLine, endLine, ser.text, false);

    // 回写后新文档里从范围起点（含外部前缀）起算 cellOffset，应指向 "new"
    const rangeStartOffset = after
      .split("\n")
      .slice(0, startLine - 1)
      .reduce((n, l) => n + l.length + 1, 0);
    const absOffset = rangeStartOffset + ser.cellOffset;
    expect(after.slice(absOffset, absOffset + 3)).toBe("new");

    // 且 parseTableSource 回读解析出的 raw 与写入内容一致
    const rangeText = after
      .split("\n")
      .slice(startLine - 1, startLine + ser.text.split("\n").length - 1)
      .join("\n");
    const parsed = parseTableSource(rangeText, "html");
    expect(parsed?.rows[0][0].raw).toBe("new");
  });
});