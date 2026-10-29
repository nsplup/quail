/**
 * 装饰器单元测试（本次修复引入的两个导出）：
 * - applyMarksToNodes：从 applyMarks 抽出的纯函数（任意 RootContent[] 上装饰）；
 * - decorateCellMap：单元格 Map 批量装饰（EditableTable 本地解析结果用）。
 *
 * 覆盖目标：
 * 1. applyMarksToNodes 的切分形态（整段 / 中间 / 前缀 / 后缀 / 多命中 /
 *    跨元素 / 空 hits / 负 id）；
 * 2. decorateCellMap 的短路行为（active=false / re=null 返回原引用）、
 *    未命中原引用保留、命中装饰、多个单元格独立装饰；
 * 3. 负 id 不命中 pv-search-current（保护 current 语义）。
 */
import { describe, expect, it } from "vitest";
import type { Element, ElementContent, RootContent, Text } from "hast";
import { applyMarksToNodes, decorateCellMap } from "../../preview/previewSearch";

function text(value: string): Text {
  return { type: "text", value };
}

function el(tagName: string, children: ElementContent[]): Element {
  return { type: "element", tagName, properties: {}, children };
}

/** 遍历收集所有文本（验证装饰不丢字符） */
function collectText(nodes: RootContent[]): string {
  let out = "";
  const walk = (n: RootContent): void => {
    if (n.type === "text") {
      out += n.value;
      return;
    }
    if (n.type === "element") {
      for (const c of n.children) walk(c as RootContent);
    }
  };
  for (const n of nodes) walk(n);
  return out;
}

/** 遍历收集所有 mark 的 { id, text } */
function collectMarks(
  nodes: RootContent[],
): Array<{ id: string; text: string }> {
  const out: Array<{ id: string; text: string }> = [];
  const walk = (n: RootContent): void => {
    if (n.type !== "element") return;
    if (n.tagName === "mark") {
      out.push({
        id: String((n.properties as Record<string, unknown>)?.["data-mid"] ?? ""),
        text: collectText(n.children as RootContent[]),
      });
    }
    for (const c of n.children) walk(c as RootContent);
  };
  for (const n of nodes) walk(n);
  return out;
}

describe("applyMarksToNodes：命中切分形态", () => {
  it("整段命中：单个 mark 包裹全文", () => {
    const result = applyMarksToNodes([text("hello")], [{ s: 0, e: 5, id: 0 }]);
    expect(result).toHaveLength(1);
    expect(collectText(result)).toBe("hello");
    expect(collectMarks(result)).toEqual([{ id: "0", text: "hello" }]);
  });

  it("中间命中：text + mark + text", () => {
    const result = applyMarksToNodes([text("hello world")], [
      { s: 2, e: 7, id: 5 },
    ]);
    expect(result.map((n) => n.type)).toEqual(["text", "element", "text"]);
    expect(collectMarks(result)).toEqual([{ id: "5", text: "llo w" }]);
    expect(collectText(result)).toBe("hello world");
  });

  it("前缀命中：mark + text", () => {
    const result = applyMarksToNodes([text("hello world")], [
      { s: 0, e: 5, id: 1 },
    ]);
    expect(result.map((n) => n.type)).toEqual(["element", "text"]);
    expect(collectMarks(result)).toEqual([{ id: "1", text: "hello" }]);
    expect(collectText(result)).toBe("hello world");
  });

  it("后缀命中：text + mark", () => {
    const result = applyMarksToNodes([text("hello world")], [
      { s: 6, e: 11, id: 2 },
    ]);
    expect(result.map((n) => n.type)).toEqual(["text", "element"]);
    expect(collectMarks(result)).toEqual([{ id: "2", text: "world" }]);
    expect(collectText(result)).toBe("hello world");
  });

  it("多个命中：独立 mark，id 各自对应", () => {
    const hits = [
      { s: 0, e: 1, id: 0 },
      { s: 4, e: 5, id: 1 },
      { s: 8, e: 9, id: 2 },
    ];
    const result = applyMarksToNodes([text("a b a b a")], hits);
    expect(collectMarks(result)).toEqual([
      { id: "0", text: "a" },
      { id: "1", text: "a" },
      { id: "2", text: "a" },
    ]);
    expect(collectText(result)).toBe("a b a b a");
  });

  it("空 hits：原引用返回（未变更）", () => {
    const nodes: RootContent[] = [text("hello")];
    const result = applyMarksToNodes(nodes, []);
    expect(result).toBe(nodes);
  });

  it("负 id（局部装饰）：data-mid 原样写入字符串", () => {
    const result = applyMarksToNodes([text("x")], [
      { s: 0, e: 1, id: -100_000 },
    ]);
    expect(collectMarks(result)).toEqual([{ id: "-100000", text: "x" }]);
  });
});

describe("applyMarksToNodes：跨元素命中", () => {
  it("命中落在 <strong> 内部：不跨元素边界", () => {
    const nodes: RootContent[] = [
      text("ab"),
      el("strong", [text("cd")]),
      text("ef"),
    ];
    // 命中 "bcd" (plain offset 1..4)
    const result = applyMarksToNodes(nodes, [{ s: 1, e: 4, id: 0 }]);
    // 期望拆成两个 mark（不跨越元素边界）
    const marks = collectMarks(result);
    expect(marks).toEqual([
      { id: "0", text: "b" },
      { id: "0", text: "cd" },
    ]);
    expect(collectText(result)).toBe("abcdef");
  });

  it("命中完全落在 <strong> 内：单 mark 在 strong 内", () => {
    const nodes: RootContent[] = [
      text("ab"),
      el("strong", [text("cd")]),
      text("ef"),
    ];
    // 命中 "c" (offset 2..3)
    const result = applyMarksToNodes(nodes, [{ s: 2, e: 3, id: 7 }]);
    expect(collectMarks(result)).toEqual([{ id: "7", text: "c" }]);
    expect(collectText(result)).toBe("abcdef");
  });
});

describe("decorateCellMap：短路与装饰", () => {
  it("active=false → 原 map 引用返回", () => {
    const map = new Map<string, ElementContent[]>([
      ["0:0", [text("hello")]],
    ]);
    const result = decorateCellMap(map, { active: false, re: /hello/g });
    expect(result).toBe(map);
  });

  it("re=null → 原 map 引用返回", () => {
    const map = new Map<string, ElementContent[]>([
      ["0:0", [text("hello")]],
    ]);
    const result = decorateCellMap(map, { active: true, re: null });
    expect(result).toBe(map);
  });

  it("命中单元格被装饰；未命中单元格原引用保留", () => {
    const hitCell: ElementContent[] = [text("hello")];
    const missCell: ElementContent[] = [text("world")];
    const map = new Map([
      ["0:0", hitCell],
      ["0:1", missCell],
    ]);
    const result = decorateCellMap(map, { active: true, re: /hello/g });
    expect(collectMarks(result.get("0:0")!)).toEqual([
      { id: "-100000", text: "hello" },
    ]);
    // 未命中单元格：children 引用未变（keyed diff 友好）
    expect(result.get("0:1")).toBe(missCell);
  });

  it("空文本单元格保持原引用", () => {
    const empty: ElementContent[] = [];
    const map = new Map([["0:0", empty]]);
    const result = decorateCellMap(map, { active: true, re: /x/g });
    expect(result.get("0:0")).toBe(empty);
  });

  it("多个单元格命中：各自独立装饰", () => {
    const map = new Map([
      ["0:0", [text("aa")] as ElementContent[]],
      ["0:1", [text("aa")] as ElementContent[]],
    ]);
    const result = decorateCellMap(map, { active: true, re: /a/g });
    // 每格两个 mark
    expect(collectMarks(result.get("0:0")!).length).toBe(2);
    expect(collectMarks(result.get("0:1")!).length).toBe(2);
    // 内容不丢
    expect(collectText(result.get("0:0")!)).toBe("aa");
    expect(collectText(result.get("0:1")!)).toBe("aa");
  });

  it("所有单元格的 data-mid 均为负值（不误标 pv-search-current）", () => {
    const map = new Map([
      ["0:0", [text("hello")] as ElementContent[]],
      ["0:1", [text("world")] as ElementContent[]],
    ]);
    const result = decorateCellMap(map, { active: true, re: /o/g });
    for (const children of result.values()) {
      for (const m of collectMarks(children)) {
        expect(Number(m.id)).toBeLessThan(0);
      }
    }
  });
});