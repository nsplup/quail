/**
 * image-ref.ts 纯函数单元测试：引用标识符规范化（micromark
 * normalizeIdentifier 口径）、定义引用格式插入文本构建（批内查重 /
 * 与现有文档定义撞名 / 多图定义块聚合）。
 */
import { describe, expect, it } from "vitest";
import {
  buildImageInsertText,
  imageStemOf,
  normalizeImageRefId,
} from "../image-ref";

describe("normalizeImageRefId：micromark 标识符口径", () => {
  it("折叠连续空白为单空格并 trim、小写", () => {
    expect(normalizeImageRefId("  My  Photo\t\n")).toBe("my photo");
    expect(normalizeImageRefId("A\r\nB")).toBe("a b");
  });

  it("CJK 原样保留（仅拉丁小写化）", () => {
    expect(normalizeImageRefId("截图 2026")).toBe("截图 2026");
    expect(normalizeImageRefId("SCREEN截图.PNG")).toBe("screen截图.png");
  });

  it("空串 / 纯空白回落 img", () => {
    expect(normalizeImageRefId("")).toBe("img");
    expect(normalizeImageRefId("   ")).toBe("img");
  });
});

describe("imageStemOf：去最后一个扩展名", () => {
  it("常规 / 多级扩展名 / 无扩展名 / 隐藏文件", () => {
    expect(imageStemOf("photo.png")).toBe("photo");
    expect(imageStemOf("a.b.png")).toBe("a.b");
    expect(imageStemOf("README")).toBe("README");
    expect(imageStemOf(".gitignore")).toBe(".gitignore"); // i === 0 不去
  });
});

describe("buildImageInsertText：定义引用格式", () => {
  it("单图：引用行 + 空行 + 定义行", () => {
    const text = buildImageInsertText(
      [{ name: "photo.png", relPath: "photo.md.assets/photo.png" }],
      ""
    );
    expect(text).toBe(
      "![photo][photo]\n\n[photo]: photo.md.assets/photo.png"
    );
  });

  it("多图：引用行以空行分隔，定义行聚合在尾部一个块内", () => {
    const text = buildImageInsertText(
      [
        { name: "a.png", relPath: "x.md.assets/a.png" },
        { name: "b.jpg", relPath: "x.md.assets/b.jpg" },
      ],
      ""
    );
    expect(text).toBe(
      "![a][a]\n\n![b][b]\n\n[a]: x.md.assets/a.png\n[b]: x.md.assets/b.jpg"
    );
  });

  it("同名文件批内查重：第二个起追加 -2 后缀", () => {
    const text = buildImageInsertText(
      [
        { name: "img.png", relPath: "x.md.assets/img.png" },
        { name: "img.png", relPath: "x.md.assets/img-1.png" },
        { name: "img.png", relPath: "x.md.assets/img-2.png" },
      ],
      ""
    );
    expect(text).toContain("![img][img]");
    expect(text).toContain("![img][img-2]");
    expect(text).toContain("![img][img-3]");
    expect(text).toContain("[img]: x.md.assets/img.png");
    expect(text).toContain("[img-2]: x.md.assets/img-1.png");
    expect(text).toContain("[img-3]: x.md.assets/img-2.png");
  });

  it("与现有文档引用定义撞名时追加后缀（CommonMark 首定义优先）", () => {
    const doc = "# title\n\n[photo]: old/path.png\n";
    const text = buildImageInsertText(
      [{ name: "photo.png", relPath: "x.md.assets/photo.png" }],
      doc
    );
    expect(text).toBe(
      "![photo][photo-2]\n\n[photo-2]: x.md.assets/photo.png"
    );
  });

  it("规范化后撞名同样追加后缀（大小写 / 空白差异的文件名）", () => {
    const text = buildImageInsertText(
      [
        { name: "My Photo.png", relPath: "x.md.assets/my photo.png" },
        { name: "my  photo.png", relPath: "x.md.assets/my photo-1.png" },
      ],
      ""
    );
    expect(text).toContain("![My Photo][my photo]");
    expect(text).toContain("[my photo-2]: x.md.assets/my photo-1.png");
  });
});
