package main

// image_import_test.go：插入图片后端通道的单元测试。
// - ClassifyFiles：魔数归类（image / text / other）与 SVG 归入 other；
// - ImportImageFiles：仅放行真实图片，SVG / 非图片静默跳过；
// - stashClipboardImage / CommitClipboardImage：粘贴链路的校验与落盘两步；
// - saveImageBytes 哈希命名：无文件名来源（粘贴）→ img-<hash>；
// - assetsDirForInsert：markdown 伴生目录（<docName>.assets）与非 markdown
//   回落 assets/；
// - uniqueAssetName：冲突递增后缀与时间戳兜底命名。

import (
	"os"
	"path/filepath"
	"regexp"
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
	if _, err := os.Stat(filepath.Join(dir, "note.md.assets", "ok.png")); err != nil {
		t.Errorf("saved file missing: %v", err)
	}
}

func TestStashClipboardImage(t *testing.T) {
	// 每次测试前清空单槽，避免互相干扰
	defer func() {
		pendingClipboardImage.mu.Lock()
		pendingClipboardImage.id = 0
		pendingClipboardImage.data = nil
		pendingClipboardImage.mu.Unlock()
	}()

	// 正常 PNG：ok=true + PendingID 非 0
	p := stashClipboardImage([]byte(pngMagic))
	if p.Kind != "image" || !p.Ok || p.PendingID == 0 {
		t.Fatalf("stash(png): kind=%s ok=%v id=%d, want image/true/>0", p.Kind, p.Ok, p.PendingID)
	}
	// 槽位实际写入
	pendingClipboardImage.mu.Lock()
	if pendingClipboardImage.id != p.PendingID || len(pendingClipboardImage.data) == 0 {
		pendingClipboardImage.mu.Unlock()
		t.Fatalf("pending slot not set after stash")
	}
	pendingClipboardImage.mu.Unlock()

	// SVG 拒绝：reason=format
	if p := stashClipboardImage([]byte("<svg></svg>")); p.Reason != "format" {
		t.Errorf("stash(svg): reason=%q, want format", p.Reason)
	}
	// 非图片拒绝：reason=format
	if p := stashClipboardImage([]byte("plain text")); p.Reason != "format" {
		t.Errorf("stash(text): reason=%q, want format", p.Reason)
	}
	// 超过 20MB：reason=size（大小校验先于魔数）
	if p := stashClipboardImage(make([]byte, clipboardMaxImageBytes+1)); p.Reason != "size" {
		t.Errorf("stash(oversize): reason=%q, want size", p.Reason)
	}
}

func TestCommitClipboardImage(t *testing.T) {
	dir := t.TempDir()
	docPath := writeTemp(t, dir, "note.md", "# hello\n")
	svc := &FileService{doc: &docStatus{path: docPath}}

	defer func() {
		pendingClipboardImage.mu.Lock()
		pendingClipboardImage.id = 0
		pendingClipboardImage.data = nil
		pendingClipboardImage.mu.Unlock()
	}()

	// 正常：stash + commit 落盘，命名 img-<hash>.png
	stashed := stashClipboardImage([]byte(pngMagic))
	img, err := svc.CommitClipboardImage(stashed.PendingID)
	if err != nil {
		t.Fatalf("CommitClipboardImage: %v", err)
	}
	if img == nil || !strings.HasPrefix(img.RelPath, "note.md.assets/img-") {
		t.Fatalf("img = %+v, want under note.md.assets/img-*", img)
	}
	hashRe := regexp.MustCompile(`^img-[0-9a-f]{8}\.png$`)
	if !hashRe.MatchString(img.Name) {
		t.Errorf("Name = %q, want img-<hex8>.png", img.Name)
	}
	if _, err := os.Stat(filepath.Join(dir, "note.md.assets", img.Name)); err != nil {
		t.Errorf("saved file missing: %v", err)
	}

	// 重复消费同一 PendingID：error（槽位已空）
	if _, err := svc.CommitClipboardImage(stashed.PendingID); err == nil {
		t.Error("CommitClipboardImage(reuse): expect error, got nil")
	}
	// 无暂存 / ID 不存在：error
	if _, err := svc.CommitClipboardImage(999999); err == nil {
		t.Error("CommitClipboardImage(unknown id): expect error, got nil")
	}
	// 无文档：stash 成功但 commit 时 assetsDirForInsert 报错
	svc.doc = nil
	stashed = stashClipboardImage([]byte(pngMagic))
	if _, err := svc.CommitClipboardImage(stashed.PendingID); err == nil {
		t.Error("CommitClipboardImage(no doc): expect error, got nil")
	}

	// 端到端幂等：同一内容两次 stash + commit → 复用同一文件
	s1 := stashClipboardImage([]byte(pngMagic))
	i1, err := svc.CommitClipboardImage(s1.PendingID)
	if err != nil {
		t.Fatalf("commit#1: %v", err)
	}
	s2 := stashClipboardImage([]byte(pngMagic))
	i2, err := svc.CommitClipboardImage(s2.PendingID)
	if err != nil {
		t.Fatalf("commit#2: %v", err)
	}
	if i1.Name != i2.Name {
		t.Errorf("two pastes: names differ %q vs %q, want reuse", i1.Name, i2.Name)
	}
}

func TestSaveImageBytesHashNaming(t *testing.T) {
	dir := t.TempDir()

	// 无文件名来源（粘贴）：img-<hex8>.png
	img1, ok := saveImageBytes(dir, []byte(pngMagic), "")
	if !ok {
		t.Fatalf("saveImageBytes: ok=false")
	}
	hashRe := regexp.MustCompile(`^img-[0-9a-f]{8}\.png$`)
	if !hashRe.MatchString(img1.Name) {
		t.Errorf("Name = %q, want img-<hex8>.png", img1.Name)
	}

	// 有文件名来源：沿用原名（哈希不介入）
	img2, ok := saveImageBytes(dir, []byte(pngMagic), "photo.png")
	if !ok {
		t.Fatalf("saveImageBytes(named): ok=false")
	}
	if img2.Name != "photo.png" {
		t.Errorf("Name = %q, want photo.png", img2.Name)
	}

	// 同内容重复粘贴：复用，不生成 -1 副本
	img3, ok := saveImageBytes(dir, []byte(pngMagic), "")
	if !ok {
		t.Fatalf("saveImageBytes(repeat): ok=false")
	}
	if img3.Name != img1.Name {
		t.Errorf("repeat paste: Name = %q, want reuse %q", img3.Name, img1.Name)
	}
	// 目录内 img-<hash>.png 只有一份
	var hashFiles int
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if hashRe.MatchString(e.Name()) {
			hashFiles++
		}
	}
	if hashFiles != 1 {
		t.Errorf("expect 1 hash-named file after repeat paste, got %d", hashFiles)
	}

	// 不同内容（尾部追加一字节）：不同哈希 → 不同名，各自落盘
	img4, ok := saveImageBytes(dir, []byte(pngMagic+"x"), "")
	if !ok {
		t.Fatalf("saveImageBytes(different): ok=false")
	}
	if img4.Name == img1.Name {
		t.Errorf("different content: same Name %q, want different", img4.Name)
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
	// 兜底：空 baseName 走时间戳命名（正常调用方不会传空，
	// saveImageBytes 会先注入 img-<hash>）
	got := uniqueAssetName(dir, "", ".png")
	if !strings.HasPrefix(got, "img-") || !strings.HasSuffix(got, ".png") {
		t.Errorf("uniqueAssetName(no name) = %q, want img-<timestamp>.png", got)
	}
}
