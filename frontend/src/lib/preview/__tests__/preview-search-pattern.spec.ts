/**
 * previewSearch.ts 匹配管线核心单元测试（装饰链路另见
 * preview-search-decor.spec.ts）：查找条件 → 正则构建（转义 / 大小写 /
 * 全词 / 正则语法 / ReDoS 拦截 / 零宽守卫）、HAST 文本展平、命中区间
 * 查找（零宽保护 + 数量上限）与全段匹配列表（含脚注伪段与溢出截断）。
 */
import { describe, expect, it } from "vitest";
import type { RootContent } from "hast";
import type { HastSegment } from "../../markdown/markdown-core";
import {
  PREVIEW_MATCH_CAP,
  buildPreviewPattern,
  computePreviewMatches,
  findRanges,
  flattenHastText,
} from "../previewSearch";

/** 便捷构建查找条件 */
function pat(
  search: string,
  o: Partial<{ caseSensitive: boolean; regexp: boolean; wholeWord: boolean }> = {},
) {
  return buildPreviewPattern({
    search,
    caseSensitive: o.caseSensitive ?? false,
    regexp: o.regexp ?? false,
    wholeWord: o.wholeWord ?? false,
  });
}

describe("buildPreviewPattern：查找条件 → 匹配正则", () => {
  it("空条件 → null 正则（不报错）", () => {
    expect(pat("")).toEqual({ re: null, bad: false, unsafe: null });
  });

  it("普通文本按字面匹配：元字符被转义", () => {
    const { re, bad, unsafe } = pat("a.b");
    expect(bad).toBe(false);
    expect(unsafe).toBeNull();
    expect(re!.test("axb")).toBe(false); // 未转义时会误命中
    expect("a.b axb".match(re!)).toEqual(["a.b"]);
  });

  it("大小写开关", () => {
    expect(pat("Hello")!.re!.test("say hello")).toBe(true);
    expect(pat("Hello", { caseSensitive: true })!.re!.test("say hello")).toBe(
      false,
    );
    expect(
      pat("Hello", { caseSensitive: true })!.re!.test("say Hello"),
    ).toBe(true);
  });

  it("全词匹配遵循 \\b 词界（与编辑区口径一致）", () => {
    const { re } = pat("word", { wholeWord: true });
    expect("a word here".match(re!)).toEqual(["word"]);
    expect(re!.test("keyword")).toBe(false);
    expect(re!.test("word2")).toBe(false);
  });

  it("正则模式：透传用户模式", () => {
    const { re, bad } = pat("h.llo", { regexp: true });
    expect(bad).toBe(false);
    // `.` 通配任意单字符：hello / hallo 命中；hallllo（需 h..llo）不命中
    expect("hello hallo hallllo".match(re!)).toEqual(["hello", "hallo"]);
  });

  it("正则语法无效 → bad=true（不上岗）", () => {
    expect(pat("([unclosed", { regexp: true })).toEqual({
      re: null,
      bad: true,
      unsafe: null,
    });
  });

  it("ReDoS（灾难性回溯）模式被拦截", () => {
    const r = pat("(a+)+$", { regexp: true });
    expect(r.re).toBeNull();
    expect(r.bad).toBe(false);
    expect(r.unsafe).toBe("redos");
  });

  it("零宽守卫：能匹配空串的模式被拦截（普通模式转义后不受影响）", () => {
    expect(pat("a*", { regexp: true }).unsafe).toBe("zeroWidth");
    expect(pat("a*").unsafe).toBeNull(); // 字面 "a*"，不匹配空串
    const literal = pat("a*")!;
    expect("a*b".match(literal.re!)).toEqual(["a*"]);
  });
});

describe("flattenHastText：HAST 子树 → 展平文本", () => {
  it("text 节点按序拼接，元素递归展开", () => {
    const nodes = [
      { type: "text", value: "hello " },
      {
        type: "element",
        tagName: "strong",
        children: [{ type: "text", value: "world" }],
      },
      { type: "text", value: "!" },
    ] as unknown as RootContent[];
    expect(flattenHastText(nodes)).toBe("hello world!");
  });

  it("非 text / 无 children 的节点（comment 等）跳过", () => {
    const nodes = [
      { type: "comment", value: "ignored" },
      { type: "text", value: "kept" },
    ] as unknown as RootContent[];
    expect(flattenHastText(nodes)).toBe("kept");
  });
});

describe("findRanges：命中区间查找", () => {
  it("返回 [start, end) 区间，全局 g 正则连续推进", () => {
    const { re } = pat("ab");
    expect(findRanges("ab x ab", re!)).toEqual([
      [0, 2],
      [5, 7],
    ]);
  });

  it("零宽匹配强制前进，不产生区间也不死循环", () => {
    // "a*"（正则）已被零宽守卫拦截，此处直接构造零宽正则验证保护层
    const re = /b*/g;
    expect(findRanges("ab", re)).toEqual([[1, 2]]);
    expect(findRanges("xyz", re)).toEqual([]);
  });

  it("数量上限：达到 cap 停止", () => {
    const { re } = pat("x");
    expect(findRanges("xxxx", re!, 2)).toEqual([
      [0, 1],
      [1, 2],
    ]);
  });
});

describe("computePreviewMatches：全段匹配列表", () => {
  const seg = (text: string): HastSegment =>
    ({
      type: "paragraph",
      nodes: [{ type: "text", value: text }],
    }) as unknown as HastSegment;

  it("多段匹配：total / segOf / base / ranges 一致", () => {
    const { re } = pat("md");
    const info = computePreviewMatches(
      [seg("md a"), seg("nothing"), seg("md md")],
      re!,
      [],
    );
    expect(info.total).toBe(3);
    expect(info.overflow).toBe(false);
    expect(info.segOf).toEqual([0, 2, 2]);
    expect(info.base).toEqual([0, 1, 1, 3]); // 含脚注伪段基线
    expect(info.ranges).toEqual([
      [0, 2],
      [0, 2],
      [3, 5],
    ]);
    expect(info.footnoteIndex).toBe(-1); // 无脚注命中
  });

  it("脚注区作为伪段参与匹配：footnoteIndex = 正文段数", () => {
    const { re } = pat("note");
    const info = computePreviewMatches(
      [seg("plain")],
      re!,
      [{ identifier: "f1", def: { children: [{ type: "text", value: "a note" }] as unknown as RootContent[] } }],
    );
    expect(info.total).toBe(1);
    expect(info.footnoteIndex).toBe(1);
    expect(info.segOf).toEqual([1]);
    expect(info.ranges).toEqual([[2, 6]]);
  });

  it("超上限截断：total 封顶、overflow 置位（999+ 展示语义）", () => {
    const { re } = pat("x");
    const many = Array.from({ length: PREVIEW_MATCH_CAP + 10 }, () =>
      seg("x"),
    );
    const info = computePreviewMatches(many, re!, []);
    expect(info.total).toBe(PREVIEW_MATCH_CAP);
    expect(info.overflow).toBe(true);
    expect(info.segOf.length).toBe(PREVIEW_MATCH_CAP);
    expect(info.ranges.length).toBe(PREVIEW_MATCH_CAP);
  });

  it("re 为 null（空条件）→ 空列表", () => {
    const info = computePreviewMatches([seg("anything")], null, []);
    expect(info.total).toBe(0);
    expect(info.footnoteIndex).toBe(-1);
  });
});
