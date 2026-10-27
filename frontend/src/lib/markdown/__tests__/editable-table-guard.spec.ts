/**
 * 可编辑表格守卫测试（P0 / P5）：
 * - isStaticTable（HAST 纯函数）：colspan / rowspan 合并（含 colSpan 驼峰
 *   键名、字符串数字值、非法值回落 1）→ 静态；
 * - readNumberAttr：键名 / 值类型兼容矩阵；
 * - tableOriginFromEl：data-html-table 标记的宽值读取（布尔 / 字符串
 *   "false" / 数字 / 缺失）。
 * （"nested" 为 DOM 判定、"attrs" 为源码侧 parseTableSource 报告——后者
 * 见 table-codec.spec；两者在 EditableTable.isStatic 内与 span 合流。）
 */
import { describe, expect, it } from "vitest";
import type { Element, ElementContent, Properties } from "hast";
import { readNumberAttr } from "../hast-attrs";
import { isStaticTable, tableOriginFromEl } from "../table-source";

function el(
  tagName: string,
  properties: Properties = {},
  children: ElementContent[] = [],
): Element {
  return { type: "element", tagName, properties, children };
}

function td(properties: Properties = {}): Element {
  return el("td", properties, [{ type: "text", value: "x" }]);
}

function table(...rows: Element[]): Element {
  const trs = rows.map((cells) =>
    cells.type === "element" && cells.tagName === "td"
      ? el("tr", {}, [cells])
      : cells,
  );
  return el("table", {}, [el("tbody", {}, trs)]);
}

describe("readNumberAttr：数值属性兼容矩阵", () => {
  it("kebab-case 键（number / string 值）", () => {
    expect(readNumberAttr({ colspan: 2 }, "colspan")).toBe(2);
    expect(readNumberAttr({ rowspan: "3" }, "rowspan")).toBe(3);
  });

  it("camelCase 键（property-information 规范化后）", () => {
    expect(readNumberAttr({ colSpan: 2 }, "colspan")).toBe(2);
    expect(readNumberAttr({ rowSpan: "4" }, "rowspan")).toBe(4);
  });

  it("缺失 / 非法 / < 1 → 回落 1", () => {
    expect(readNumberAttr({}, "colspan")).toBe(1);
    expect(readNumberAttr(undefined, "rowspan")).toBe(1);
    expect(readNumberAttr({ colspan: "x" }, "colspan")).toBe(1);
    expect(readNumberAttr({ colspan: 0 }, "colspan")).toBe(1);
    expect(readNumberAttr({ colspan: -1 }, "colspan")).toBe(1);
    expect(readNumberAttr({ colspan: 2.7 }, "colspan")).toBe(2);
  });
});

describe("isStaticTable：span 合并守卫（前置拦截）", () => {
  it("无合并 → 不静态", () => {
    const t = table(td(), td());
    expect(isStaticTable(t)).toEqual({ static: false });
  });

  it.each([
    ["colspan 数字", { colspan: 2 }],
    ["colspan 字符串", { colspan: "2" }],
    ["colSpan 驼峰", { colSpan: 2 }],
    ["rowspan 数字", { rowspan: 3 }],
    ["rowspan 字符串", { rowspan: "3" }],
  ])("%s → 静态（reason: span）", (_name, props) => {
    const t = table(td(), td(props));
    expect(isStaticTable(t)).toEqual({ static: true, reason: "span" });
  });

  it("非法 span 值（\"x\" / 0 / 负数）→ 回落 1，不静态", () => {
    expect(isStaticTable(table(td({ colspan: "x" })))).toEqual({ static: false });
    expect(isStaticTable(table(td({ colspan: 0 })))).toEqual({ static: false });
    expect(isStaticTable(table(td({ colspan: -1 })))).toEqual({ static: false });
  });

  it("thead 行的 th 合同样受守卫覆盖", () => {
    const th = el("th", { colspan: 2 }, [{ type: "text", value: "h" }]);
    const t = el("table", {}, [el("thead", {}, [el("tr", {}, [th])])]);
    expect(isStaticTable(t)).toEqual({ static: true, reason: "span" });
  });
});

describe("tableOriginFromEl：来源标记读取（宽值兼容）", () => {
  it("data-html-table（布尔 true / 字符串 / 数字 / 驼峰）→ html", () => {
    expect(tableOriginFromEl(el("table", { "data-html-table": true }))).toBe("html");
    expect(tableOriginFromEl(el("table", { "data-html-table": "true" }))).toBe("html");
    expect(tableOriginFromEl(el("table", { dataHtmlTable: 1 }))).toBe("html");
  });

  it("缺标记 / false / \"false\" / 0 / 空串 → markdown", () => {
    expect(tableOriginFromEl(el("table"))).toBe("markdown");
    expect(tableOriginFromEl(el("table", { "data-html-table": false }))).toBe("markdown");
    expect(tableOriginFromEl(el("table", { "data-html-table": "false" }))).toBe("markdown");
    expect(tableOriginFromEl(el("table", { "data-html-table": 0 }))).toBe("markdown");
    expect(tableOriginFromEl(el("table", { "data-html-table": "" }))).toBe("markdown");
  });
});
