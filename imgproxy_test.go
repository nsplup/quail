package main

// imgproxy.go 纯逻辑单元测试：白名单包含判定（含 ".." 文件名不误杀、
// 逃逸拒绝、大小写不敏感文件系统折叠）与图片 Content-Type 魔数嗅探。

import (
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
