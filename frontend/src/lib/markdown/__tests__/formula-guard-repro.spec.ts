import { describe, expect, it } from "vitest";
import { parseMarkdown, buildBlocksIncremental } from "../markdown-core";

/** 递归找 mdast inlineMath / hast md-math */
function findNode(
  nodes: unknown[],
  pred: (n: { type?: string; tagName?: string }) => boolean,
): unknown[] {
  const out: unknown[] = [];
  const visit = (arr: unknown[]) => {
    for (const n of arr as { type?: string; tagName?: string; children?: unknown[] }[]) {
      if (pred(n)) out.push(n);
      if (Array.isArray(n.children)) visit(n.children);
    }
  };
  visit(nodes);
  return out;
}

describe("行内公式空格守卫：正文 vs 脚注列表", () => {
  it("正文内 $ a $ 不产出 inlineMath（基线确认守卫生效）", () => {
    const src = "正文 $ a $ 与 $5 与 $3。";
    const root = parseMarkdown(src);
    const im = findNode(root.children as unknown[], (n) => n.type === "inlineMath");
    expect(im.length).toBe(0);
  });

  it("脚注定义内容 $ a $ 也不应产出 inlineMath（守卫应覆盖脚注）", () => {
    const src = ["见注[^1]。", "", "[^1]: 脚注 $ a $ 与 $5 与 $3。"].join("\n");
    const root = parseMarkdown(src);
    const im = findNode(root.children as unknown[], (n) => n.type === "inlineMath");
    // eslint-disable-next-line no-console
    console.log("mdast inlineMath count:", im.length, JSON.stringify(im, null, 1));
    expect(im.length).toBe(0);
  });

  it("端到端：脚注列表 STORE 内容不应包含 md-math 元素", () => {
    const src = ["见注[^1]。", "", "[^1]: 脚注 $ a $ 与 $5 与 $3。"].join("\n");
    const state = {
      src: "",
      root: null,
      hast: null,
      blocks: [],
      incrementalCount: 0,
      lastFullAt: 0,
      refsBaseline: null,
    };
    const r = buildBlocksIncremental(state, src, true);
    const fn = r.refs!.footnotes.find((f) => f.identifier === "1");
    expect(fn).toBeTruthy();
    const mm = findNode(fn!.children as unknown[], (n) => n.tagName === "md-math");
    // eslint-disable-next-line no-console
    console.log("hast md-math count:", mm.length, JSON.stringify(fn!.children, null, 1));
    expect(mm.length).toBe(0);
    const text = JSON.stringify(fn!.children);
    expect(text).toContain("$ a $");
  });
});
