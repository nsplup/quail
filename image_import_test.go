package main

// image_import_test.go：插入图片后端通道的单元测试。
// - ClassifyFiles：魔数归类（image / text / other）与 SVG 归入 other；
// - ImportImageFiles：仅放行真实图片，SVG / 非图片静默跳过；
// - SaveImageData：SVG 与非图片拒绝，图片落盘伴生资源目录且返回
//   相对路径；
// - assetsDirForInsert：markdown 伴生目录（<docName>.assets）与非
//   markdown 回落 assets/；
// - uniqueImageName：冲突递增后缀与时间戳命名。

import (
        "os"
        "path/filepath"
        "strings"
        "testing"
)

const pngMagic = "\x89PNG\r\n\x1a\n" + "rest-of-image"

func writeTemp(t *testing.T, dir, name, content string) string {
        t.Helper()
        p := filepath.Join(dir, name)
        if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
                t.Fatalf("write %s: %v", name, err)
        }
        return p
}

func TestClassifyFiles(t *testing.T) {
        dir := t.TempDir()
        png := writeTemp(t, dir, "pic.png", pngMagic)
        gif := writeTemp(t, dir, "anim.gif", "GIF89a....")
        svg := writeTemp(t, dir, "vector.svg", "<?xml version=\"1.0\"?><svg xmlns=\"\"></svg>")
        txt := writeTemp(t, dir, "note.txt", "hello, world")
        bin := writeTemp(t, dir, "data.bin", "\x00\x01\x02\x03garbage")
        missing := filepath.Join(dir, "not-exists.png")

        kinds, err := (&FileService{}).ClassifyFiles([]string{png, gif, svg, txt, bin, missing})
        if err != nil {
                t.Fatalf("ClassifyFiles: %v", err)
        }
        if len(kinds) != 6 {
                t.Fatalf("expect 6 kinds, got %d", len(kinds))
        }
        want := []string{"image", "image", "other", "text", "other", "other"}
        for i, w := range want {
                if kinds[i].Kind != w {
                        t.Errorf("kinds[%d].Kind = %q, want %q", i, kinds[i].Kind, w)
                }
        }
}

func TestImportImageFilesSkipsNonImage(t *testing.T) {
        dir := t.TempDir()
        docPath := writeTemp(t, dir, "note.md", "# hello\n")
        svc := &FileService{doc: &docStatus{path: docPath}}

        png := writeTemp(t, dir, "ok.png", pngMagic)
        svg := writeTemp(t, dir, "bad.svg", "<svg></svg>")
        bin := writeTemp(t, dir, "bad.bin", "\x00\x01\x02")

        imgs, err := svc.ImportImageFiles([]string{png, svg, bin})
        if err != nil {
                t.Fatalf("ImportImageFiles: %v", err)
        }
        if len(imgs) != 1 {
                t.Fatalf("expect 1 imported (svg/bin skipped), got %d: %+v", len(imgs), imgs)
        }
        if imgs[0].Name != "ok.png" {
                t.Errorf("Name = %q, want ok.png", imgs[0].Name)
        }
        if !strings.HasPrefix(imgs[0].RelPath, "note.md.assets/ok.png") {
                t.Errorf("RelPath = %q, want under note.md.assets/", imgs[0].RelPath)
        }
        // 落盘文件存在
        if _, err := os.Stat(filepath.Join(dir, "note.md.assets", "ok.png")); err != nil {
                t.Errorf("saved file missing: %v", err)
        }
}

func TestSaveImageData(t *testing.T) {
        dir := t.TempDir()
        docPath := writeTemp(t, dir, "note.md", "# hello\n")
        svc := &FileService{doc: &docStatus{path: docPath}}

        // 正常图片：落盘 + 相对路径返回
        img, err := svc.SaveImageData([]byte(pngMagic))
        if err != nil {
                t.Fatalf("SaveImageData(png): %v", err)
        }
        if !strings.HasPrefix(img.RelPath, "note.md.assets/img-") {
                t.Errorf("RelPath = %q, want img-<timestamp> under note.md.assets/", img.RelPath)
        }
        if !strings.HasSuffix(img.Name, ".png") {
                t.Errorf("Name = %q, want .png suffix (magic-derived)", img.Name)
        }

        // SVG 拒绝（三入口统一丢弃口径）
        if _, err := svc.SaveImageData([]byte("<svg></svg>")); err == nil {
                t.Error("SaveImageData(svg): expect error, got nil")
        }

        // 非图片拒绝
        if _, err := svc.SaveImageData([]byte("plain text, not an image")); err == nil {
                t.Error("SaveImageData(text): expect error, got nil")
        }

        // 未打开文档拒绝
        if _, err := (&FileService{}).SaveImageData([]byte(pngMagic)); err == nil {
                t.Error("SaveImageData(no doc): expect error, got nil")
        }
}

func TestAssetsDirForInsert(t *testing.T) {
        dir := t.TempDir()
        svc := &FileService{}

        // markdown：伴生资源目录 <docName>.assets
        svc.doc = &docStatus{path: filepath.Join(dir, "note.md")}
        got, err := svc.assetsDirForInsert()
        if err != nil {
                t.Fatalf("assetsDirForInsert(md): %v", err)
        }
        if got != filepath.Join(dir, "note.md.assets") {
                t.Errorf("md dir = %q, want %q", got, filepath.Join(dir, "note.md.assets"))
        }

        // 大小写扩展名同样识别（Note.MD → Note.md.assets，白名单首候选形态）
        svc.doc = &docStatus{path: filepath.Join(dir, "Note.MD")}
        if got, _ = svc.assetsDirForInsert(); got != filepath.Join(dir, "Note.md.assets") {
                t.Errorf("Note.MD dir = %q, want %q", got, filepath.Join(dir, "Note.md.assets"))
        }

        // 非 markdown：回落 assets/
        svc.doc = &docStatus{path: filepath.Join(dir, "note.txt")}
        if got, _ = svc.assetsDirForInsert(); got != filepath.Join(dir, "assets") {
                t.Errorf("txt dir = %q, want %q", got, filepath.Join(dir, "assets"))
        }

        // 未打开文档报错
        svc.doc = nil
        if _, err := svc.assetsDirForInsert(); err == nil {
                t.Error("assetsDirForInsert(no doc): expect error, got nil")
        }
}

func TestUniqueAssetName(t *testing.T) {
        dir := t.TempDir()
        take := func(name string) string {
                p := filepath.Join(dir, name)
                if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
                        t.Fatalf("setup %s: %v", name, err)
                }
                return p
        }

        // 无冲突：原名（扩展名换成本次校验出的真实扩展名）
        if got := uniqueAssetName(dir, "photo.png", ".png"); got != "photo.png" {
                t.Errorf("uniqueAssetName(no conflict) = %q", got)
        }
        // 冲突：-1 / -2 递增
        take("photo.png")
        if got := uniqueAssetName(dir, "photo.png", ".png"); got != "photo-1.png" {
                t.Errorf("uniqueAssetName(conflict) = %q, want photo-1.png", got)
        }
        take("photo-1.png")
        if got := uniqueAssetName(dir, "photo.png", ".png"); got != "photo-2.png" {
                t.Errorf("uniqueAssetName(conflict x2) = %q, want photo-2.png", got)
        }
        // 无扩展名文件
        take("README")
        if got := uniqueAssetName(dir, "README", ""); got != "README-1" {
                t.Errorf("uniqueAssetName(no ext) = %q, want README-1", got)
        }
        // 无文件名来源（粘贴）：img-<时间戳> 命名
        got := uniqueAssetName(dir, "", ".png")
        if !strings.HasPrefix(got, "img-") || !strings.HasSuffix(got, ".png") {
                t.Errorf("uniqueAssetName(no name) = %q, want img-<timestamp>.png", got)
        }
}
