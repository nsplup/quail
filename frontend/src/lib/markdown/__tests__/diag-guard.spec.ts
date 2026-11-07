import { describe, expect, it } from "vitest";
import { parseMarkdown, buildBlocksIncremental } from "../markdown-core";

function findAll(nodes: unknown[], pred: (n: { type?: string; tagName?: string }) => boolean): unknown[] {
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

const state = () => ({
  src: "", root: null, hast: null, blocks: [],
  incrementalCount: 0, lastFullAt: 0, refsBaseline: null,
});

describe("诊断：正文 vs 脚注（非对称用例）", () => {
  it("正文：价格 $5 与 $3", () => {
    const root = parseMarkdown("价格 $5 与 $3。");
    const im = findAll(root.children as unknown[], (n) => n.type === "inlineMath");
    console.log("BODY inlineMath:", im.length, JSON.stringify(root.children));
    expect(im.length).toBe(0);
  });

  it("脚注：价格 $5 与 $3（端到端 STORE 内容）", () => {
    const src = "见注[^1]。\n\n[^1]: 价格 $5 与 $3。";
    const r = buildBlocksIncremental(state(), src, true);
    const fn = r.refs!.footnotes.find((f) => f.identifier === "1")!;
    const mm = findAll(fn.children as unknown[], (n) => n.tagName === "md-math");
    console.log("FN md-math:", mm.length, JSON.stringify(fn.children));
    expect(mm.length).toBe(0);
  });

  it("脚注：值 $ a $（对称用例）", () => {
    const src = "见注[^1]。\n\n[^1]: 值 $ a $。";
    const r = buildBlocksIncremental(state(), src, true);
    const fn = r.refs!.footnotes.find((f) => f.identifier === "1")!;
    const mm = findAll(fn.children as unknown[], (n) => n.tagName === "md-math");
    console.log("FN(a) md-math:", mm.length, JSON.stringify(fn.children));
    expect(mm.length).toBe(0);
  });

  it("正文：值 $ a $（对称用例）", () => {
    const root = parseMarkdown("值 $ a $。");
    const im = findAll(root.children as unknown[], (n) => n.type === "inlineMath");
    console.log("BODY(a) inlineMath:", im.length, JSON.stringify(root.children));
    expect(im.length).toBe(0);
  });
});
