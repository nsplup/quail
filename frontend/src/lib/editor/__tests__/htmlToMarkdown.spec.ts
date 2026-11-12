/**
 * htmlToMarkdown 单元测试：unified 管线转换（标题/强调/链接/图片/列表）、
 * img 链接原样保留、表格对齐、可转换标签检测（无 Markdown 语义标签时
 * 跳过输出管线，convertible=false）
 */
import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "../htmlToMarkdown";

describe("htmlToMarkdown：语义映射（非 SHIFT）", () => {
  it("标题 → ATX 标题", () => {
    expect(htmlToMarkdown("<h1>Title</h1>").markdown).toBe("# Title");
    expect(htmlToMarkdown("<h2>Sub</h2>").markdown).toBe("## Sub");
  });

  it("加粗 / 斜体 / 行内代码", () => {
    expect(htmlToMarkdown("<p><b>bold</b></p>").markdown).toBe("**bold**");
    expect(htmlToMarkdown("<p><i>it</i></p>").markdown).toBe("*it*");
    expect(htmlToMarkdown("<p><code>x=1</code></p>").markdown).toBe("`x=1`");
  });

  it("链接保留 href", () => {
    expect(
      htmlToMarkdown('<p><a href="https://a.b">link</a></p>').markdown
    ).toBe("[link](https://a.b)");
  });

  it("img 标签中的链接保持原样（不改写、不本地化）", () => {
    const md = htmlToMarkdown(
      '<p>before<img src="https://x.y/img.png?v=1#f" alt="cap">after</p>'
    ).markdown;
    expect(md).toContain("![cap](https://x.y/img.png?v=1#f)");
    expect(md).toContain("before");
    expect(md).toContain("after");
  });

  it("无序列表", () => {
    const md = htmlToMarkdown("<ul><li>one</li><li>two</li></ul>").markdown;
    expect(md).toBe("- one\n- two");
  });

  it("GFM 表格", () => {
    const md = htmlToMarkdown(
      "<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>"
    ).markdown;
    expect(md).toContain("| a |");
    expect(md).toContain("| 1 |");
    expect(md).toContain("|");
  });

  it("保留表格对齐（align 属性）", () => {
    const md = htmlToMarkdown(
      '<table><tr><th align="center">a</th></tr><tr><td align="center">1</td></tr></table>'
    ).markdown;
    expect(md).toContain(":---:");
  });

  it("保留表格对齐（style=text-align）", () => {
    const md = htmlToMarkdown(
      '<table><tr><th style="text-align:right">a</th></tr><tr><td style="text-align:right">1</td></tr></table>'
    ).markdown;
    expect(md).toContain("---:");
  });
});

describe("htmlToMarkdown：可转换检测", () => {
  it("完全无可转换标签（div/span/p/font）→ convertible=false 且跳过输出", () => {
    expect(
      htmlToMarkdown("<div><span>plain</span></div><p>text</p>")
    ).toEqual({ convertible: false, markdown: "" });
    expect(htmlToMarkdown('<font color="red">styled</font>')).toEqual({
      convertible: false,
      markdown: "",
    });
  });

  it("存在可转换标签 → convertible=true", () => {
    expect(htmlToMarkdown("<div>plain <b>bold</b></div>")).toEqual({
      convertible: true,
      markdown: "plain **bold**",
    });
    expect(htmlToMarkdown("<p>text</p><code>c</code>").convertible).toBe(true);
  });

  it("GFM 删除线 / 任务列表标签视为可转换", () => {
    expect(htmlToMarkdown("<del>gone</del>").convertible).toBe(true);
    expect(
      htmlToMarkdown(
        '<ul><li><input type="checkbox" checked>done</li></ul>'
      ).convertible
    ).toBe(true);
  });

  it("嵌套深层可转换标签也能检出", () => {
    expect(
      htmlToMarkdown(
        '<div><section><article><a href="https://x.y">l</a></article></section></div>'
      ).convertible
    ).toBe(true);
  });
});
