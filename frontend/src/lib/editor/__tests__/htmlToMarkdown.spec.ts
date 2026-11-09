/**
 * htmlToMarkdown 单元测试：unified 管线转换（标题/强调/链接/图片/列表）、
 * img 链接原样保留、SHIFT 模式丢弃样式保留图片。
 */
import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "../htmlToMarkdown";

describe("htmlToMarkdown：语义映射（非 SHIFT）", () => {
  it("标题 → ATX 标题", () => {
    expect(htmlToMarkdown("<h1>Title</h1>")).toBe("# Title");
    expect(htmlToMarkdown("<h2>Sub</h2>")).toBe("## Sub");
  });

  it("加粗 / 斜体 / 行内代码", () => {
    expect(htmlToMarkdown("<p><b>bold</b></p>")).toBe("**bold**");
    expect(htmlToMarkdown("<p><i>it</i></p>")).toBe("*it*");
    expect(htmlToMarkdown("<p><code>x=1</code></p>")).toBe("`x=1`");
  });

  it("链接保留 href", () => {
    expect(htmlToMarkdown('<p><a href="https://a.b">link</a></p>')).toBe(
      "[link](https://a.b)"
    );
  });

  it("img 标签中的链接保持原样（不改写、不本地化）", () => {
    const md = htmlToMarkdown(
      '<p>before<img src="https://x.y/img.png?v=1#f" alt="cap">after</p>'
    );
    expect(md).toContain("![cap](https://x.y/img.png?v=1#f)");
    expect(md).toContain("before");
    expect(md).toContain("after");
  });

  it("无序列表", () => {
    const md = htmlToMarkdown("<ul><li>one</li><li>two</li></ul>");
    expect(md).toBe("- one\n- two");
  });

  it("GFM 表格", () => {
    const md = htmlToMarkdown(
      "<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>"
    );
    expect(md).toContain("| a |");
    expect(md).toContain("| 1 |");
    expect(md).toContain("|");
  });
});

describe("htmlToMarkdown：SHIFT 丢弃样式（strip = true）", () => {
  it("标题降级为段落纯文本", () => {
    expect(htmlToMarkdown("<h1>Title</h1>", true)).toBe("Title");
  });

  it("加粗 / 斜体 / 链接褪壳为纯文本", () => {
    expect(htmlToMarkdown("<p><b>bold</b> plain</p>", true)).toBe("bold plain");
    expect(
      htmlToMarkdown('<p><a href="https://a.b">link</a></p>', true)
    ).toBe("link");
  });

  it("图文混排：丢弃样式但保留图片", () => {
    const md = htmlToMarkdown(
      '<h2>Notes</h2><p><b>see</b> <img src="https://x.y/a.png" alt="a"> <em>now</em></p>',
      true
    );
    expect(md).toContain("![a](https://x.y/a.png)");
    expect(md).not.toContain("**");
    expect(md).not.toContain("##");
    expect(md).toContain("see");
    expect(md).toContain("now");
  });

  it("列表结构保留（不属于样式），列表项内样式褪壳", () => {
    const md = htmlToMarkdown(
      "<ul><li><b>x</b></li><li>y</li></ul>",
      true
    );
    expect(md).toBe("- x\n- y");
  });
});
