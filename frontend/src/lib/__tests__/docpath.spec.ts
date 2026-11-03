/**
 * docpath.ts 纯函数单元测试：另存路径切分（必须同时识别 / 与 \ 分隔符，
 * Windows 路径失真防护）与布局模式白名单校验。
 */
import { describe, expect, it } from "vitest";
import { isValidMode, splitSavePath } from "../docpath";

describe("splitSavePath：绝对路径 → { dir, name }", () => {
  it("POSIX 路径按 / 切分", () => {
    expect(splitSavePath("/home/u/docs/notes.md")).toEqual({
      dir: "/home/u/docs",
      name: "notes.md",
    });
  });

  it("Windows 路径按 \\ 切分（只按 / 切会把 dir/name 解析成整条路径）", () => {
    expect(splitSavePath("C:\\Users\\u\\notes.md")).toEqual({
      dir: "C:\\Users\\u",
      name: "notes.md",
    });
  });

  it("混合分隔符按最后出现的任一分隔符切分", () => {
    expect(splitSavePath("C:\\Users\\u/docs/notes.md")).toEqual({
      dir: "C:\\Users\\u/docs",
      name: "notes.md",
    });
  });

  it("根目录文件：dir 为根分隔符本身", () => {
    expect(splitSavePath("/notes.md")).toEqual({ dir: "/", name: "notes.md" });
  });

  it("无分隔符（相对裸文件名）：dir 回落为整条路径", () => {
    expect(splitSavePath("notes.md")).toEqual({
      dir: "notes.md",
      name: "notes.md",
    });
  });

  it("文件名含点号不影响切分（按分隔符而非扩展名）", () => {
    expect(splitSavePath("/tmp/a.b.c.md")).toEqual({
      dir: "/tmp",
      name: "a.b.c.md",
    });
  });

  it("文件名含 .. 不影响切分（目录语义由后端白名单校验）", () => {
    expect(splitSavePath("/tmp/a..b.png")).toEqual({
      dir: "/tmp",
      name: "a..b.png",
    });
  });

  it("分隔符后为空名：dir 正确切分，name 回落整条路径", () => {
    expect(splitSavePath("/tmp/dir/")).toEqual({
      dir: "/tmp/dir",
      name: "/tmp/dir/",
    });
  });
});

describe("isValidMode：布局模式白名单", () => {
  it("合法模式放行", () => {
    expect(isValidMode("source")).toBe(true);
    expect(isValidMode("split")).toBe(true);
    expect(isValidMode("preview")).toBe(true);
  });

  it("非法值一律拒绝（配置文件可能残留非法值）", () => {
    expect(isValidMode("edit")).toBe(false);
    expect(isValidMode("SOURCE")).toBe(false); // 大小写敏感
    expect(isValidMode("")).toBe(false);
    expect(isValidMode(null)).toBe(false);
    expect(isValidMode(undefined)).toBe(false);
    expect(isValidMode(123)).toBe(false);
    expect(isValidMode({ mode: "split" })).toBe(false);
  });
});
