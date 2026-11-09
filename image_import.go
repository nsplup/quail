package main

// ImageImport：插入图片模块的后端支撑（FileService 绑定方法）。
//
// 三个插入入口（底栏按钮 / 拖拽 / 粘贴）的落盘通道：
//   - ClassifyFiles：拖拽分流——对拖入文件逐个做魔数嗅探，归类
//     image / text / other，由前端决定走"打开文档"还是"插入图片"；
//   - ImportImageFiles：按钮多选 / 拖拽的图片导入——逐个魔数校验，
//     仅放行真实图片（SVG 一律拒绝，三入口口径统一），失败静默跳过；
//   - SaveImageData：粘贴 image/* 的字节落盘——后端对前端传来的字节
//     再次做魔数校验（双保险），SVG 与非图片一律拒绝。
//
// 存储位置（imgproxy 本地代理白名单内，前端 <md-image> 可直接渲染）：
//   - markdown 文档：<docDir>/<BASE>.assets/（伴生资源目录，见
//     imgproxy.go 的 companionAssetsNames 白名单口径）；
//   - 非 markdown 文本文档（companionAssetsNames 返回 nil，无伴生目录
//     口径）：回落 <docDir>/assets/（白名单固定放行的资产子目录）。
//
// 命名：有文件名（按钮 / 拖拽）沿用原文件名，冲突时追加 -1/-2… 递增
// 后缀；无文件名（粘贴）img-<时间戳>，同时间戳冲突同样递增后缀。
//
// 返回的 RelPath 一律为相对文档目录的正斜杠路径，可直接用于 markdown
// 引用定义与 imgproxy 的 p= 参数。

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// FileKindInfo 拖拽文件分类结果（ClassifyFiles 单项）。
type FileKindInfo struct {
	Path string `json:"path"`
	// Kind 按文件头魔数归类的种类：
	//   image —— imageMagic 命中（SVG 除外：SVG 按 other 归类，统一丢弃口径）；
	//   text  —— isTextFile 判定为文本文件；
	//   other —— 其余（含不存在/不可读文件、SVG）。
	Kind string `json:"kind"`
}

// ImportedImage 图片资源落盘结果。
type ImportedImage struct {
	// RelPath 相对当前文档目录的正斜杠路径（assets/img.png 形态）。
	RelPath string `json:"relPath"`
	// Name 落盘文件名（含扩展名，冲突时带 -n 后缀）。
	Name string `json:"name"`
}

// ClassifyFiles 拖拽分流：对文件列表逐个魔数嗅探归类。
// 单个文件不可读（不存在 / 目录 / 无权限 / 空路径）时该项 Kind 记为
// other，并在返回的 error 中聚合（errors.Join）；全部成功时 error 为 nil。
// 调用方可选择忽略 error 只消费分类结果（宽松分流），也可据此提示用户。
func (f *FileService) ClassifyFiles(paths []string) ([]*FileKindInfo, error) {
	if len(paths) == 0 {
		return []*FileKindInfo{}, nil
	}
	out := make([]*FileKindInfo, 0, len(paths))
	var errs []error
	for _, p := range paths {
		info := &FileKindInfo{Path: p, Kind: "other"}
		out = append(out, info)
		// 先探测可读性：读不了的文件无法分类，归 other 并收集错误
		// （原实现由 isSVGFile / isTextFileHead 静默吞掉）
		if _, err := readFileHead(p); err != nil {
			errs = append(errs, fmt.Errorf("classify %q: %w", p, err))
			continue
		}
		switch {
		case isSVGFile(p):
			// SVG 本质文本，先排除；三入口统一丢弃口径 → other
			info.Kind = "other"
		case isImageFile(p):
			info.Kind = "image"
		case isTextFileHead(p):
			info.Kind = "text"
		}
	}
	return out, errors.Join(errs...)
}

// ImportImageFiles 批量导入磁盘图片文件到当前文档的资产目录。
// 校验失败的文件静默跳过（三入口统一"仅放行真实图片、SVG 拒绝"口径）；
// 无打开文档（未保存）时返回错误（前端入口侧已先引导保存，此为兜底）。
func (f *FileService) ImportImageFiles(paths []string) ([]*ImportedImage, error) {
	assetsDir, err := f.assetsDirForInsert()
	if err != nil {
		return nil, err
	}
	out := make([]*ImportedImage, 0, len(paths))
	for _, p := range paths {
		data, err := os.ReadFile(p)
		if err != nil {
			continue // 不可读：静默跳过
		}
		img, ok := saveImageBytes(assetsDir, data, filepath.Base(p))
		if !ok {
			continue // 非图片 / SVG：静默跳过
		}
		out = append(out, img)
	}
	return out, nil
}

// SaveImageData 粘贴链路落盘：前端剪贴板 image/* 的原始字节写入资产
// 目录并返回引用信息。后端魔数二次校验（SVG / 非图片拒绝），ext 由
// 内容魔数推导，不信任前端提供的扩展名。
func (f *FileService) SaveImageData(data []byte) (*ImportedImage, error) {
	assetsDir, err := f.assetsDirForInsert()
	if err != nil {
		return nil, err
	}
	img, ok := saveImageBytes(assetsDir, data, "")
	if !ok {
		return nil, errors.New("unsupported image data")
	}
	return img, nil
}

// assetsDirForInsert 当前文档的图片落盘目录（伴生资源目录优先，非
// markdown 文档回落 assets/），目录不存在时创建。
func (f *FileService) assetsDirForInsert() (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.doc == nil || f.doc.path == "" {
		return "", errors.New("no document open")
	}
	docDir := filepath.Dir(f.doc.path)
	docName := filepath.Base(f.doc.path)
	dir := docDir // 默认直接落文档目录的 assets/ 子目录
	if names := companionAssetsNames(docName); len(names) > 0 {
		// markdown 文档：伴生资源目录。companionAssetsNames 首候选
		// [BASE].md.assets 即 <docName>.assets 形态（note.md →
		// note.md.assets），与 imgproxy 白名单同口径
		dir = filepath.Join(docDir, names[0])
	} else {
		dir = filepath.Join(docDir, "assets")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	return dir, nil
}

// saveImageBytes 魔数校验 + 唯一化命名 + 原子写入。
// baseName 为空表示无文件名来源（粘贴），使用 img-<时间戳>；
// 非图片内容（含 SVG）返回 (nil, false)，调用方按丢弃/拒绝处理。
func saveImageBytes(assetsDir string, data []byte, baseName string) (*ImportedImage, bool) {
	ct, ok := imageMagic(data)
	if !ok || ct == "image/svg+xml" {
		return nil, false // 非图片 / SVG：三入口统一拒绝
	}
	ext := extFromImageContentType(ct)
	if ext == "" {
		return nil, false
	}
	name := uniqueAssetName(assetsDir, baseName, ext)
	path := filepath.Join(assetsDir, name)
	if err := writeFileAtomic(path, data, 0o644); err != nil {
		return nil, false
	}
	rel := pathRelativeToDoc(assetsDir, name)
	return &ImportedImage{RelPath: rel, Name: name}, true
}

// extFromImageContentType imageMagic 命中的 Content-Type → 标准扩展名。
func extFromImageContentType(ct string) string {
	switch ct {
	case "image/png":
		return ".png"
	case "image/jpeg":
		return ".jpg"
	case "image/gif":
		return ".gif"
	case "image/webp":
		return ".webp"
	case "image/bmp":
		return ".bmp"
	case "image/x-icon":
		return ".ico"
	case "image/avif":
		return ".avif"
	default:
		return ""
	}
}

// uniqueAssetName 资产文件名唯一化：
//   - 有原文件名：沿用 stem（去扩展名），换成本次校验出的真实扩展名；
//     与现有文件冲突时追加 -1/-2… 递增后缀；
//   - 无原文件名：img-<YYYYMMDD-HHMMSSmmm> 时间戳命名，冲突同样递增。
//
// 命名竞争窗口仅限并发插入（同实例内插入操作由前端串行触发），不做
// 文件锁，最后一步 write 失败由调用方按丢弃处理。
func uniqueAssetName(assetsDir, baseName, ext string) string {
	stem := ""
	if baseName != "" {
		stem = strings.TrimSuffix(baseName, filepath.Ext(baseName))
		if stem == "" {
			stem = "" // 形如 ".png" 的裸扩展名输入：回落时间戳命名
		}
	}
	if stem == "" {
		stem = "img-" + time.Now().Format("20060102-150405.000")
	}
	candidate := stem + ext
	for i := 1; ; i++ {
		if _, err := os.Stat(filepath.Join(assetsDir, candidate)); err != nil {
			return candidate // 不存在（或不可见）：直接采用
		}
		candidate = fmt.Sprintf("%s-%d%s", stem, i, ext)
	}
}

// pathRelativeToDoc 资产文件相对文档目录的引用路径（正斜杠）。
// assetsDir 由 assetsDirForInsert 在文档目录下创建，Rel 必然不含 ".."。
func pathRelativeToDoc(assetsDir, name string) string {
	docDir := filepath.Dir(assetsDir)
	rel, err := filepath.Rel(docDir, filepath.Join(assetsDir, name))
	if err != nil {
		return name // 理论不可达：回落裸文件名
	}
	return filepath.ToSlash(rel)
}

// isSVGFile 磁盘文件是否为 SVG（只读文件头嗅探，与 isSVGData 同口径）。
func isSVGFile(path string) bool {
	data, err := readFileHead(path)
	if err != nil {
		return false
	}
	return isSVGData(data)
}

// isTextFileHead 磁盘文件是否为文本文件（isTextFile 的路径版包装，
// 只读文件头，不整读大文件）。
func isTextFileHead(path string) bool {
	data, err := readFileHead(path)
	if err != nil {
		return false
	}
	return isTextFile(data)
}

// readFileHead 读取文件前 4KB（魔数嗅探用；不足 4KB 返回实际长度）。
func readFileHead(path string) ([]byte, error) {
	fh, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer fh.Close()
	head := make([]byte, 4096)
	n, err := io.ReadFull(fh, head)
	if err != nil && err != io.ErrUnexpectedEOF && err != io.EOF {
		return nil, err
	}
	return head[:n], nil
}
