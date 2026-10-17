package main

// file_service.go 集成式单元测试：watch fire 路径（真实 fsnotify + 临时目录）。
//
// 验证修复后的关键行为：
//   1. 外部修改文件 → 防抖后 lastKnown 同步为磁盘新内容（fire 正常工作，
//      代际校验不误伤本会话）；
//   2. 自身保存 → 写入令牌抑制回环，lastKnown 更新且内容不被误报；
//   3. CloseDoc 换文档后旧 fire 不再触碰新 doc（代际 + 路径校验，
//      修复前旧定时器会把旧文档变动误报到新文档上）；
//   4. BOM 往返：带 BOM 的 UTF-8 文档保存后 BOM 保留（文件失真防护）。

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func waitFor(t *testing.T, timeout time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("等待条件超时")
}

func (f *FileService) lastKnown() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.doc == nil {
		return ""
	}
	return f.doc.lastKnown
}

// TestFileService_ExternalChangeUpdatesBaseline 外部修改 → fire 更新基线。
func TestFileService_ExternalChangeUpdatesBaseline(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "doc.md")
	if err := os.WriteFile(path, []byte("v1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	f := NewFileService()
	defer f.stopWatch()
	if _, err := f.Open(path); err != nil {
		t.Fatal(err)
	}
	initial := f.lastKnown()

	// 外部追加写入（模拟另一编辑器）
	if err := os.WriteFile(path, []byte("v1\nv2 external\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	want := sha256Hex([]byte("v1\nv2 external\n"))
	waitFor(t, 5*time.Second, func() bool { return f.lastKnown() == want })
	_ = initial
}

// TestFileService_SelfWriteSuppressed 自身保存 → 回环抑制 + 基线同步。
func TestFileService_SelfWriteSuppressed(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "doc.md")
	if err := os.WriteFile(path, []byte("v1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	f := NewFileService()
	defer f.stopWatch()
	if _, err := f.Open(path); err != nil {
		t.Fatal(err)
	}
	res, err := f.Save("v1\nsaved\n", false)
	if err != nil || res == nil || !res.Ok {
		t.Fatalf("Save 失败: res=%+v err=%v", res, err)
	}
	want := sha256Hex([]byte("v1\nsaved\n"))
	if f.lastKnown() != want {
		t.Fatalf("保存后 lastKnown 应为新内容指纹")
	}
	// 磁盘内容校验
	raw, _ := os.ReadFile(path)
	if string(raw) != "v1\nsaved\n" {
		t.Fatalf("磁盘内容不一致: %q", raw)
	}
}

// TestFileService_StaleFireAfterClose 换文档后旧 fire 不误报（BUG-4 回归）。
func TestFileService_StaleFireAfterClose(t *testing.T) {
	dir := t.TempDir()
	pathA := filepath.Join(dir, "a.md")
	pathB := filepath.Join(dir, "b.md")
	if err := os.WriteFile(pathA, []byte("A\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(pathB, []byte("B\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	f := NewFileService()
	defer f.stopWatch()
	if _, err := f.Open(pathA); err != nil {
		t.Fatal(err)
	}
	// 打开 A 后立即切换到 B（A 的 watch 被停止；若存在未决定时器，
	// 修复前其 fire 会重读 f.doc 并可能误报 B 被外部修改）
	if _, err := f.Open(pathB); err != nil {
		t.Fatal(err)
	}
	// 外部修改 A：B 的基线不应被 A 的任何事件触碰
	if err := os.WriteFile(pathA, []byte("A modified\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	baselineB := sha256Hex([]byte("B\n"))
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if f.lastKnown() != baselineB {
			t.Fatalf("换文档后 B 的基线被误改（旧 fire 未被代际校验拦截）")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// TestFileService_BOMPreserved BOM 往返：打开带 BOM 文档 → 保存 → BOM 保留
// 且内容、基线一致（BUG-1 回归）。
func TestFileService_BOMPreserved(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "doc.md")
	if err := os.WriteFile(path, utf8BOM("# 标题\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	f := NewFileService()
	defer f.stopWatch()
	st, err := f.Open(path)
	if err != nil || st == nil {
		t.Fatalf("Open: %v", err)
	}
	if st.Content != "# 标题\n" || st.Encoding != "utf-8" {
		t.Fatalf("Open 内容/编码不符: %q %q", st.Content, st.Encoding)
	}
	if _, err := f.Save("# 标题\n正文\n", false); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytesHasBOM(raw) {
		t.Fatalf("保存后 BOM 丢失（文件失真）: % x", raw[:minInt(6, len(raw))])
	}
	if string(raw[3:]) != "# 标题\n正文\n" {
		t.Fatalf("保存后内容不一致: %q", string(raw[3:]))
	}
	if f.lastKnown() != sha256Hex(raw) {
		t.Fatalf("lastKnown 应与磁盘实际字节一致")
	}
	// 无 BOM 文档：保存后不引入 BOM
	path2 := filepath.Join(dir, "plain.md")
	if err := os.WriteFile(path2, []byte("plain\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := f.Open(path2); err != nil {
		t.Fatal(err)
	}
	if _, err := f.Save("plain2\n", false); err != nil {
		t.Fatal(err)
	}
	raw2, _ := os.ReadFile(path2)
	if bytesHasBOM(raw2) {
		t.Fatalf("无 BOM 文档不应被引入 BOM")
	}
}

func bytesHasBOM(b []byte) bool {
	return len(b) >= 3 && b[0] == 0xEF && b[1] == 0xBB && b[2] == 0xBF
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// TestFileService_SaveAsResult 另存结果携带 Dir/Name（BUG-5 后端侧）+ BOM 跟随。
func TestFileService_SaveAsResult(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "src.md")
	if err := os.WriteFile(src, utf8BOM("content\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	f := NewFileService()
	defer f.stopWatch()
	if _, err := f.Open(src); err != nil {
		t.Fatal(err)
	}
	dst := filepath.Join(dir, "out.md")
	res, err := f.SaveAs(dst, "content2\n")
	if err != nil || res == nil || !res.Ok {
		t.Fatalf("SaveAs: %+v %v", res, err)
	}
	if res.Dir != dir || res.Name != "out.md" {
		t.Fatalf("SaveResult Dir/Name: %q %q", res.Dir, res.Name)
	}
	raw, _ := os.ReadFile(dst)
	if !bytesHasBOM(raw) || string(raw[3:]) != "content2\n" {
		t.Fatalf("另存应跟随源文件 BOM 语义: % x", raw)
	}
}
