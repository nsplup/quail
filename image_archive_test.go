package main

// ImageArchive 单测：引用收集 / 解析分类 / 替换（不触网，远程解析只验证
// 分类与命名推导；落盘链路由 saveImageBytes 既有测试覆盖）。

import (
        "os"
        "path/filepath"
        "strings"
        "testing"
)

func TestNormalizeRefID(t *testing.T) {
        cases := map[string]string{
                "Pic 1":     "pic 1",
                "  A   B ":  "a b",
                "IMG":       "img",
                "tab\tkey":  "tab key",
        }
        for in, want := range cases {
                if got := normalizeRefID(in); got != want {
                        t.Errorf("normalizeRefID(%q) = %q, want %q", in, got, want)
                }
        }
}

func TestMarkdownDest(t *testing.T) {
        cases := map[string]string{
                "note.md.assets/pic.png":      "note.md.assets/pic.png",
                "note.md.assets/pic 1.png":    "<note.md.assets/pic 1.png>",
                "a(b).png":                    "<a(b).png>",
                "x.png":                       "x.png",
        }
        for in, want := range cases {
                if got := markdownDest(in); got != want {
                        t.Errorf("markdownDest(%q) = %q, want %q", in, got, want)
                }
        }
}

func TestCollectUsedRefIDs(t *testing.T) {
        content := "![a][ Pic 1 ]\n\n![b][]\n\n[c][x]\n\n![d][unused]\n\n[Pic 1]: http://e.com/a.png"
        used := collectUsedRefIDs(content)
        if !used["pic 1"] || !used["b"] {
                t.Fatalf("want pic 1/b collected, got %v", used)
        }
        if used["x"] { // 链接引用 [c][x] 不算图片
                t.Errorf("link ref [x] should not be collected")
        }
        if !used["unused"] { // 图片 label 本身参与收集（定义缺失由后续查表兜底）
                t.Errorf("image label [unused] should be collected")
        }
}

func TestResolveArchiveRef(t *testing.T) {
        // 远程
        ref := resolveArchiveRef("https://e.com/a/pic%20x.png?v=2", "", false)
        if ref == nil || !ref.remote || ref.baseName != "pic x.png" {
                t.Fatalf("remote resolve failed: %+v", ref)
        }
        // 相对路径解析基准 = sourceDir；百分号解码
        ref = resolveArchiveRef("img%20a.png", "/docs", false)
        if ref == nil || ref.remote || ref.localAbs != filepath.Join("/docs", "img a.png") {
                t.Fatalf("local resolve failed: %+v", ref)
        }
        // HTML 实体解码（&amp; → &）
        ref = resolveArchiveRef("a&amp;b.png", "/docs", true)
        if ref == nil || ref.localAbs != filepath.Join("/docs", "a&b.png") {
                t.Fatalf("html entity resolve failed: %+v", ref)
        }
        // data: URI / 空值不参与
        if resolveArchiveRef("data:image/png;base64,AAA", "", false) != nil {
                t.Errorf("data URI should be skipped")
        }
        if resolveArchiveRef("", "", false) != nil {
                t.Errorf("empty dest should be skipped")
        }
        // 远程文件名清洗：非法字符 → _（扩展名来自查询串的部分不参与；
        // 真实扩展名由落盘时的魔数校验补齐）
        ref = resolveArchiveRef("https://e.com/a%3Fb?c.png", "", false)
        if ref == nil || ref.baseName != "a_b" {
                t.Fatalf("sanitize failed: %+v", ref)
        }
}

func TestRefDefReplacement(t *testing.T) {
        content := "![logo][Pic 1]\n\n[unused]: https://e.com/never.png\n\n[Pic 1]: https://e.com/logo.png \"Title\"\n"
        used := collectUsedRefIDs(content)
        relByKey := func(key string) (string, bool) {
                if strings.TrimSpace(key) == "https://e.com/logo.png" {
                        return "note.md.assets/logo.png", true
                }
                return "", false
        }
        got := replaceRefDefs(content, used, relByKey)
        want := "![logo][Pic 1]\n\n[unused]: https://e.com/never.png\n\n[Pic 1]: note.md.assets/logo.png \"Title\"\n"
        if got != want {
                t.Fatalf("replaceRefDefs:\n got %q\nwant %q", got, want)
        }
}

func TestInlineAndHtmlReplacement(t *testing.T) {
        content := "![a](pic.png) ![b](old/pic%202.png) ![c](<d e.png> \"t\")\n\n<img src=\"h.png\" alt=\"x\">\n<img class='k' src='single.png'>\n"
        keyToCanon := map[string]string{
                "pic.png": "c1", "old/pic%202.png": "c2", "d e.png": "c3",
                "h.png": "c4", "single.png": "c5",
        }
        relByCanon := map[string]string{
                "c1": "note.md.assets/pic.png", "c2": "note.md.assets/pic 2.png",
                "c3": "note.md.assets/d e.png", "c4": "note.md.assets/h.png",
                "c5": "note.md.assets/single.png",
        }
        relByKey := func(key string) (string, bool) {
                c, ok := keyToCanon[strings.TrimSpace(key)]
                if !ok {
                        return "", false
                }
                rel, ok := relByCanon[c]
                return rel, ok
        }
        got := inlineImageRe.ReplaceAllStringFunc(content, func(m string) string {
                g := inlineImageRe.FindStringSubmatch(m)
                if g == nil {
                        return m
                }
                dest := g[2]
                if dest == "" {
                        dest = g[3]
                }
                rel, ok := relByKey(dest)
                if !ok {
                        return m
                }
                return "![" + g[1] + "](" + markdownDest(rel) + g[4] + ")"
        })
        got = replaceHtmlImgs(got, relByKey)
        want := "![a](note.md.assets/pic.png) ![b](<note.md.assets/pic 2.png>) ![c](<note.md.assets/d e.png> \"t\")\n\n" +
                "<img src=\"note.md.assets/h.png\" alt=\"x\">\n<img class='k' src=\"note.md.assets/single.png\">\n"
        if got != want {
                t.Fatalf("inline/html replace:\n got %q\nwant %q", got, want)
        }
}

func TestAssetsDirForPath(t *testing.T) {
        dir := t.TempDir()
        target := filepath.Join(dir, "note.md")
        assetsDir, err := assetsDirForPath(target)
        if err != nil {
                t.Fatal(err)
        }
        if want := filepath.Join(dir, "note.md.assets"); assetsDir != want {
                t.Fatalf("assetsDir = %q, want %q", assetsDir, want)
        }
        if fi, err := os.Stat(assetsDir); err != nil || !fi.IsDir() {
                t.Fatalf("assets dir not created: %v", err)
        }
        // 非 markdown 回落 assets/
        assetsDir2, err := assetsDirForPath(filepath.Join(dir, "a.txt"))
        if err != nil {
                t.Fatal(err)
        }
        if want := filepath.Join(dir, "assets"); assetsDir2 != want {
                t.Fatalf("fallback assetsDir = %q, want %q", assetsDir2, want)
        }
}
