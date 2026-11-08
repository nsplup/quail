/**
 * md-math data-display 属性键形态回归测试。
 *
 * 背景：handler 原本写 kebab-case（"data-display"）。rehype-raw
 * （parse5 / property-information）会把 HAST properties 的 kebab-case
 * data-* 键规范化为 camelCase（dataDisplay），而 sanitize 保留原键形态——
 * 文档含任意 raw HTML（rehype-raw 融合路径）时键变 camelCase、不含 raw
 * 时保持 kebab。MarkdownMath 只读 kebab 的话，「$$ 独立块」在含 raw
 * HTML 的文档里会被降级成行内渲染（行为不一致）。
 *
 * 修复约定（详见 markdown-core.mdMathElement 注释）：
 * - 写侧：handler 统一写规范化形态 dataDisplay，两条路径产物一致；
 * - 读侧：MarkdownMath 经 readDataAttr 双形态兼容（防御历史产物）。
 *
 * 本套测试锁定：
 * 1. 无 raw / 含 raw 两条路径下 dataDisplay 键与值完全一致（核心回归）；
 * 2. 行内 $ 与 $$ 块的标记值在 sanitize 后仍正确区分；
 * 3. readDataAttr 对 kebab / camel / 双写 / 缺失的行为契约。
 */
import { describe, expect, it } from "vitest";
import type { Element, Root, RootContent } from "hast";
import { parseMarkdown, convertRoot } from "../markdown-core";
import { readDataAttr } from "../hast-attrs";

/** 深度优先收集全部 md-math 元素 */
function collectMath(nodes: RootContent[], out: Element[] = []): Element[] {
  for (const n of nodes) {
    if (n.type === "element") {
      if (n.tagName === "md-math") out.push(n);
      collectMath(n.children, out);
    }
  }
  return out;
}

/** dataDisplay 值序列（按文档顺序：$$ 块 → "1"，行内 → "0"） */
function displayFlags(root: Root): string[] {
  return collectMath(root.children).map(
    (el) => (el.properties as Record<string, unknown>)["dataDisplay"] as string,
  );
}

const MATH_ONLY = [
  "$$",
  "E = mc^2",
  "$$",
  "",
  "行内 $x + y$ 公式混排。",
].join("\n");

describe("md-math 属性键：有 / 无 raw HTML 行为一致（kebab-case 回归）", () => {
  it("无 raw HTML：dataDisplay 键存活且值正确（块=1 / 行内=0）", () => {
    const { hast } = convertRoot(parseMarkdown(MATH_ONLY));
    expect(displayFlags(hast)).toEqual(["1", "0"]);
  });

  it("含 raw HTML（rehype-raw 融合路径）：键被规范化后仍为 dataDisplay，与无 raw 路径完全一致", () => {
    // 任一 raw HTML 即触发 rehype-raw 融合；repro 语境下这是唯一差异源
    const withRaw = MATH_ONLY + "\n\n<div>任意 raw HTML 触发融合</div>\n";
    const a = convertRoot(parseMarkdown(MATH_ONLY)).hast;
    const b = convertRoot(parseMarkdown(withRaw)).hast;
    expect(displayFlags(b)).toEqual(["1", "0"]);
    expect(displayFlags(b)).toEqual(displayFlags(a));
  });

  it("含 raw HTML：md-math properties 不残留 kebab 键（无键形态分叉）", () => {
    const withRaw = MATH_ONLY + "\n\n<div>raw</div>\n";
    const { hast } = convertRoot(parseMarkdown(withRaw));
    for (const el of collectMath(hast.children)) {
      const props = el.properties as Record<string, unknown>;
      expect(props).not.toHaveProperty("data-display");
      expect(props["dataDisplay"]).toBeDefined();
    }
  });
});

describe("readDataAttr：data-* 属性双形态读取契约", () => {
  it("kebab-case 键（toHast 直写、未经 raw 融合的形态）", () => {
    expect(readDataAttr({ "data-display": "1" }, "data-display")).toBe("1");
  });

  it("camelCase 键（rehype-raw / property-information 规范化形态）", () => {
    expect(readDataAttr({ dataDisplay: "0" }, "data-display")).toBe("0");
  });

  it("双写时优先 kebab 名义键；值统一字符串化", () => {
    expect(
      readDataAttr({ "data-display": "1", dataDisplay: "0" }, "data-display"),
    ).toBe("1");
    expect(readDataAttr({ dataDisplay: 1 }, "data-display")).toBe("1");
  });

  it("缺失 / null / undefined 返回 undefined", () => {
    expect(readDataAttr(undefined, "data-display")).toBeUndefined();
    expect(readDataAttr({}, "data-display")).toBeUndefined();
    expect(
      readDataAttr({ "data-display": null }, "data-display"),
    ).toBeUndefined();
  });
});