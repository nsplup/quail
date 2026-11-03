/**
 * blocks.ts 纯函数单元测试：行语义（\r\n|\r|\n 统一）、行号→块下标
 * 二分映射、块行界覆盖校验（增量解析自愈判据）与三种字数统计口径
 * （character / word / hybrid，Intl.Segmenter 语义 + 可加性约定）。
 */
import { describe, expect, it } from "vitest";
import {
  blockIndexForLine,
  blocksCoverDoc,
  countTextAs,
  splitLines,
} from "../blocks";
import type { PreviewBlock } from "../../types";

/** 便捷构造块（index 不参与行界校验，任意即可） */
function block(startLine: number, endLine: number): PreviewBlock {
  return { index: startLine - 1, type: "paragraph", startLine, endLine };
}

describe("splitLines：全管线唯一行语义", () => {
  it("三种换行（\\r\\n、\\r、\\n）均切分", () => {
    expect(splitLines("a\r\nb")).toEqual(["a", "b"]);
    expect(splitLines("a\rb")).toEqual(["a", "b"]);
    expect(splitLines("a\nb")).toEqual(["a", "b"]);
  });

  it("混合换行文档（如网络小说 txt）行数与 micromark 一致", () => {
    expect(splitLines("a\r\nb\rc\nd")).toEqual(["a", "b", "c", "d"]);
  });

  it("尾随换行产出空串元素（与 micromark 行号语义一致）", () => {
    expect(splitLines("a\n")).toEqual(["a", ""]);
    expect(splitLines("a\n\n")).toEqual(["a", "", ""]);
  });

  it("空串与无换行", () => {
    expect(splitLines("")).toEqual([""]);
    expect(splitLines("no newline")).toEqual(["no newline"]);
  });

  it("splitLines 行数必须多于 split('\\n')（孤立 \\r 文档锚点防漂移）", () => {
    const src = "a\rb";
    expect(splitLines(src).length).toBeGreaterThan(src.split("\n").length);
  });
});

describe("blockIndexForLine：行号 → 块下标二分映射", () => {
  const blocks = [block(1, 3), block(4, 6), block(7, 9)];

  it("落在块内 / 块起始行 → 该块", () => {
    expect(blockIndexForLine(blocks, 1)).toBe(0);
    expect(blockIndexForLine(blocks, 3)).toBe(0);
    expect(blockIndexForLine(blocks, 4)).toBe(1);
    expect(blockIndexForLine(blocks, 9)).toBe(2);
  });

  it("块间空隙（块行界未覆盖的行）→ 前一个块", () => {
    // 实际覆盖校验由 blocksCoverDoc 兜底；映射侧取 startLine <= line 的最后一块
    expect(blockIndexForLine(blocks, 10)).toBe(2);
  });

  it("空块列表与第 0 行安全回落 0", () => {
    expect(blockIndexForLine([], 5)).toBe(0);
    expect(blockIndexForLine(blocks, 0)).toBe(0);
  });
});

describe("blocksCoverDoc：块行界无缝覆盖校验", () => {
  it("空白文档：0 块视为已覆盖（否则 worker 周期自愈空转）", () => {
    expect(blocksCoverDoc([], "")).toBe(true);
    expect(blocksCoverDoc([], "  \n\t")).toBe(true);
    expect(blocksCoverDoc([block(1, 1)], "  \n\t")).toBe(false);
  });

  it("连续覆盖（1..行数）→ true", () => {
    const src = "l1\nl2\nl3\nl4";
    expect(blocksCoverDoc([block(1, 2), block(3, 4)], src)).toBe(true);
    expect(blocksCoverDoc([block(1, 4)], src)).toBe(true);
  });

  it("缺口 / 错位 / 越界 → false", () => {
    const src = "l1\nl2\nl3\nl4";
    expect(blocksCoverDoc([block(1, 2), block(4, 4)], src)).toBe(false); // 缺第 3 行
    expect(blocksCoverDoc([block(2, 4)], src)).toBe(false); // 起点错位
    expect(blocksCoverDoc([block(1, 5)], src)).toBe(false); // 超出行数
    expect(blocksCoverDoc([block(1, 3)], src)).toBe(false); // 未到文档末尾
    expect(blocksCoverDoc([block(2, 1)], src)).toBe(false); // endLine < startLine
    expect(blocksCoverDoc([], src)).toBe(false); // 非空白文档无块
  });
});

describe("countTextAs：三种统计口径", () => {
  it("字符口径：grapheme 为最小单元（含空白，emoji ZWJ 序列为 1）", () => {
    expect(countTextAs("", "character")).toBe(0);
    expect(countTextAs("hello 中文", "character")).toBe(8);
    expect(countTextAs("a👨‍👩‍👧b", "character")).toBe(3);
  });

  it("单词口径：仅 isWordLike 段计数（标点 / 空白不计）", () => {
    expect(countTextAs("", "word")).toBe(0);
    expect(countTextAs("hello, world!", "word")).toBe(2);
    expect(countTextAs("one two\tthree\nfour", "word")).toBe(4);
    expect(countTextAs("...", "word")).toBe(0);
  });

  it("字词口径：CJK 按字计数（剔除全角标点），拉丁按词计数", () => {
    expect(countTextAs("", "hybrid")).toBe(0);
    expect(countTextAs("hello world", "hybrid")).toBe(2);
    expect(countTextAs("你好", "hybrid")).toBe(2);
    expect(countTextAs("你好，世界。", "hybrid")).toBe(4); // 全角标点剔除
    expect(countTextAs("你好 world", "hybrid")).toBe(3); // 2 字 + 1 词
  });

  it("可加性约定（word / hybrid）：块间按 \\n 切分后可加（worker 块级增量依赖）；character 口径换行符计入文档总数，不参与块级可加", () => {
    for (const mode of ["word", "hybrid"] as const) {
      const whole = countTextAs("你好世界\nhello world\n再见", mode);
      const parts =
        countTextAs("你好世界", mode) +
        countTextAs("hello world", mode) +
        countTextAs("再见", mode);
      expect(whole).toBe(parts);
    }
    // character 口径：整文档计数（含块间换行符）
    expect(countTextAs("你好\n世界", "character")).toBe(5);
  });
});
