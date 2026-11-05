package main

// imgproxy.go 单元测试：白名单包含判定（含 ".." 文件名不误杀、逃逸拒绝、
// 大小写不敏感文件系统折叠）、图片 Content-Type 魔数嗅探、本地代理
// "必须为图片"内容校验（serveLocal / resolveLocalTarget 双通道）。

import (
        "net/http"
        "net/http/httptest"
        "os"
        "path/filepath"
        "strings"
        "testing"
)

func TestPathWithinDirOn_Linux(t *testing.T) {
        cases := []struct {
                dir, target string
                want        bool
        }{
                {"/docs", "/docs", true},                    // 目录本身
                {"/docs", "/docs/a.png", true},              // 目录内
                {"/docs", "/docs/assets/a.png", true},       // assets 子目录
                {"/docs", "/docs/a..b.png", true},           // 文件名含 ".." 不误杀
                {"/docs", "/etc/passwd", false},             // 越权
                {"/docs", "/docs/../secret.txt", false},     // Clean 后逃逸（调用方已 Clean）
                {"/docs", "/docsSub/a.png", false},          // 前缀撞车目录
                {"/docs", "/docs/../../etc/passwd", false},  // 多级逃逸
        }
        for _, c := range cases {
                if got := pathWithinDirOn("linux", c.dir, c.target); got != c.want {
                        t.Errorf("pathWithinDirOn(linux, %q, %q) = %v, want %v", c.dir, c.target, got, c.want)
                }
        }
}

func TestPathWithinDirOn_CaseFold(t *testing.T) {
        // windows / darwin：默认文件系统大小写不敏感，盘符与目录大小写差异不应 403
        if !pathWithinDirOn("windows", "C:/Docs", "c:/docs/img.png") {
                t.Error("windows 大小写差异应放行")
        }
        if !pathWithinDirOn("darwin", "/Users/doc", "/users/doc/img.png") {
                t.Error("darwin 大小写差异应放行")
        }
        // 折叠不放宽越权判定
        if pathWithinDirOn("windows", "C:/Docs", "C:/Other/img.png") {
                t.Error("折叠后越权仍应拒绝")
        }
        if pathWithinDirOn("windows", "C:/Docs", "C:/Docs/../secret.txt") {
                t.Error("折叠后逃逸仍应拒绝")
        }
}

func TestSniffImageContentType(t *testing.T) {
        cases := []struct {
                name string
                data []byte
                want string
        }{
                {"png", []byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A}, "image/png"},
                {"gif87a", []byte("GIF87a-rest"), "image/gif"},
                {"gif89a", []byte("GIF89a-rest"), "image/gif"},
                {"webp", append([]byte("RIFF"), append([]byte{0, 0, 0, 0}, []byte("WEBP")...)...), "image/webp"},
                {"bmp", []byte{'B', 'M', 0, 0}, "image/bmp"},
                {"ico", []byte{0x00, 0x00, 0x01, 0x00, 0x01}, "image/x-icon"},
                {"jpeg", []byte{0xFF, 0xD8, 0xFF, 0xE0}, "image/jpeg"},
                {"svg", []byte("<svg xmlns='x'></svg>"), "image/svg+xml"},
                {"svg xml 头", []byte("<?xml version=\"1.0\"?><svg/>"), "image/svg+xml"},
                {"svg BOM+空白", append([]byte{0xEF, 0xBB, 0xBF}, []byte("  \n<svg/>")...), "image/svg+xml"},
                {"avif", append([]byte{0, 0, 0, 0}, append([]byte("ftypavif"), []byte{0, 0, 0, 0}...)...), "image/avif"},
                {"未知兜底", []byte("not an image at all"), "image/jpeg"},
        }
        for _, c := range cases {
                if got := sniffImageContentType(c.data); got != c.want {
                        t.Errorf("sniffImageContentType(%s) = %q, want %q", c.name, got, c.want)
                }
        }
}

// TestSniffImageContentType_ExtensionMismatch 防回归：URL 伪扩展名场景
// （原实现按扩展名回 Content-Type，PNG 被标成 image/jpeg）。
func TestSniffImageContentType_ExtensionMismatch(t *testing.T) {
        pngBytes := []byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A}
        // 模拟 URL 无扩展名下载得到的内容（原实现会标成 image/jpeg）
        if got := sniffImageContentType(pngBytes); got != "image/png" {
                t.Errorf("PNG 魔数应识别为 image/png，got %q（原实现按 URL 扩展名会错标）", got)
        }
        if got := sniffImageContentType([]byte("<svg/>")); got != "image/svg+xml" {
                t.Errorf("SVG 文本应识别为 image/svg+xml，got %q", got)
        }
}

// TestIsImageContent 本地代理"必须为图片"严格判定：已知魔数放行，
// 文本/二进制/空内容一律拒绝（与 sniffImageContentType 的 jpeg 兜底不同）。
func TestIsImageContent(t *testing.T) {
        pngBytes := []byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A}
        cases := []struct {
                name string
                data []byte
                want bool
        }{
                {"png", pngBytes, true},
                {"jpeg", []byte{0xFF, 0xD8, 0xFF, 0xE0}, true},
                {"gif89a", []byte("GIF89a-rest"), true},
                {"webp", append([]byte("RIFF"), append([]byte{0, 0, 0, 0}, []byte("WEBP")...)...), true},
                {"bmp", []byte{'B', 'M', 0, 0}, true},
                {"ico", []byte{0x00, 0x00, 0x01, 0x00, 0x01}, true},
                {"svg", []byte("<svg xmlns='x'></svg>"), true},
                {"avif", append([]byte{0, 0, 0, 0}, append([]byte("ftypavif"), []byte{0, 0, 0, 0}...)...), true},
                {"纯文本", []byte("hello, this is a plain text note"), false},
                {"markdown", []byte("# 标题\n\n正文内容"), false},
                {"json", []byte(`{"key": "value"}`), false},
                {"二进制随机", []byte{0x00, 0x01, 0x02, 0x7F, 0xCA, 0xFE}, false},
                {"空内容", nil, false},
                // 伪扩展名：.png 文件名 + 文本内容 → 拒绝
                {"png 扩展名但内容为文本", []byte("not a png at all"), false},
        }
        for _, c := range cases {
                if got := isImageContent(c.data); got != c.want {
                        t.Errorf("isImageContent(%s) = %v, want %v", c.name, got, c.want)
                }
        }
}

// withTestDoc 构造带已打开文档状态的 FileService（测试注入，不触达
// fsnotify / Wails 运行时），文档路径指向 dir 下的 note.md。
func withTestDoc(t *testing.T, dir string) *FileService {
        t.Helper()
        fs := NewFileService()
        fs.mu.Lock()
        fs.doc = &docStatus{path: filepath.Join(dir, "note.md"), encoding: "utf-8"}
        fs.mu.Unlock()
        return fs
}

func serveLocalRequest(t *testing.T, fs *FileService, rawQuery string) *httptest.ResponseRecorder {
        t.Helper()
        req := httptest.NewRequest(http.MethodGet, imgProxyPrefix+"local?"+rawQuery, nil)
        rec := httptest.NewRecorder()
        serveLocal(rec, req, fs)
        return rec
}

// TestServeLocal_ImageValidation 本地代理内容魔数校验：白名单内的真实
// 图片放行，文本/伪扩展名文件一律 403 not an image；白名单/404 语义不变。
func TestServeLocal_ImageValidation(t *testing.T) {
        dir := t.TempDir()
        pngBytes := []byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 'I', 'H', 'D', 'R'}
        if err := os.WriteFile(filepath.Join(dir, "real.png"), pngBytes, 0o644); err != nil {
                t.Fatal(err)
        }
        if err := os.WriteFile(filepath.Join(dir, "secret.txt"), []byte("private note"), 0o644); err != nil {
                t.Fatal(err)
        }
        // 伪扩展名：.png 文件名 + 文本内容
        if err := os.WriteFile(filepath.Join(dir, "fake.png"), []byte("this is not a png"), 0o644); err != nil {
                t.Fatal(err)
        }

        fs := withTestDoc(t, dir)

        // 真实 PNG → 200 + 魔数嗅探的 Content-Type
        rec := serveLocalRequest(t, fs, "p=real.png")
        if rec.Code != http.StatusOK {
                t.Errorf("真实图片应放行，got %d", rec.Code)
        }
        if ct := rec.Header().Get("Content-Type"); ct != "image/png" {
                t.Errorf("Content-Type 应为 image/png，got %q", ct)
        }

        // 白名单内文本文件 → 403 not an image
        rec = serveLocalRequest(t, fs, "p=secret.txt")
        if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "not an image") {
                t.Errorf("白名单内文本文件应 403 not an image，got %d %s", rec.Code, rec.Body.String())
        }

        // 伪扩展名（.png + 文本内容）→ 403 not an image
        rec = serveLocalRequest(t, fs, "p=fake.png")
        if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "not an image") {
                t.Errorf("伪扩展名文件应 403 not an image，got %d %s", rec.Code, rec.Body.String())
        }

        // 白名单与 404 语义保持不变
        rec = serveLocalRequest(t, fs, "p=../secret.txt")
        if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "access restricted") {
                t.Errorf("路径逃逸应 403 access restricted，got %d %s", rec.Code, rec.Body.String())
        }
        rec = serveLocalRequest(t, fs, "p=missing.png")
        if rec.Code != http.StatusNotFound {
            t.Errorf("不存在文件应 404，got %d", rec.Code)
        }

        // 未打开文档 → 403 document not saved（魔数校验之前）
        rec = serveLocalRequest(t, NewFileService(), "p=real.png")
        if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "document not saved") {
                t.Errorf("未打开文档应 403 document not saved，got %d %s", rec.Code, rec.Body.String())
        }
}

// TestResolveLocalTarget_ImageValidation 右键动作通道（外部打开/另存为
// 共用）与代理同口径：非图片文件拒绝，真实图片返回绝对路径。
func TestResolveLocalTarget_ImageValidation(t *testing.T) {
        dir := t.TempDir()
        pngBytes := []byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A}
        if err := os.WriteFile(filepath.Join(dir, "img.png"), pngBytes, 0o644); err != nil {
                t.Fatal(err)
        }
        if err := os.WriteFile(filepath.Join(dir, "secret.txt"), []byte("private"), 0o644); err != nil {
                t.Fatal(err)
        }
        fs := withTestDoc(t, dir)

        // 真实图片 → 返回绝对路径
        got, err := resolveProxyTarget(fs, imgProxyPrefix+"local?p=img.png")
        if err != nil {
                t.Fatalf("真实图片应解析成功: %v", err)
        }
        if want := filepath.Join(dir, "img.png"); got != want {
                t.Errorf("解析路径 = %q, want %q", got, want)
        }

        // 文本文件 → not an image
        if _, err := resolveProxyTarget(fs, imgProxyPrefix+"local?p=secret.txt"); err == nil || !strings.Contains(err.Error(), "not an image") {
                t.Errorf("文本文件应拒绝 not an image，got err=%v", err)
        }

        // 未打开文档 → document not saved
        if _, err := resolveProxyTarget(NewFileService(), imgProxyPrefix+"local?p=img.png"); err == nil || !strings.Contains(err.Error(), "document not saved") {
                t.Errorf("未打开文档应拒绝，got err=%v", err)
        }
}

// TestIsImageFile 文件头嗅探封装：大文件只读前 4KB，不整读。
func TestIsImageFile(t *testing.T) {
        dir := t.TempDir()
        pngPath := filepath.Join(dir, "a.png")
        if err := os.WriteFile(pngPath, append([]byte{0x89, 'P', 'N', 'G'}, make([]byte, 8192)...), 0o644); err != nil {
                t.Fatal(err)
        }
        if !isImageFile(pngPath) {
                t.Error("PNG 文件应判定为图片")
        }
        txtPath := filepath.Join(dir, "b.txt")
        if err := os.WriteFile(txtPath, []byte(strings.Repeat("x", 8192)), 0o644); err != nil {
                t.Fatal(err)
        }
        if isImageFile(txtPath) {
                t.Error("文本文件应判定为非图片")
        }
        if isImageFile(filepath.Join(dir, "missing.png")) {
                t.Error("不存在的文件应判定为非图片")
        }
}
