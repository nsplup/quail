package main

// ImgProxy：图片请求代理（AssetServer Middleware）。
//
// 前端 <md-image data-src> 指向：
//   /__imgproxy/local?p=<相对或绝对路径>  —— 本地文档目录资源
//   /__imgproxy/remote?url=<encoded URL> —— 远程资源（下载 + 缓存）
//
// 本地白名单：已打开文档时，仅允许文档所在目录本身或其 assets/ 子目录下的
// 文件；文档未保存（未打开）、路径越权、路径逃逸（../）一律 403 JSON 错误，
// 前端 md-image 在 error 态展示"访问受限"。白名单之外另有内容魔数校验：
// 仅放行真实图片文件——白名单目录可能含任意非图片资源（笔记附件、数据
// 文件等），纯路径校验不足以防目录内敏感文件被代理读出，本地与远程统一
// "必须为图片"口径。
//
// 远程：仅 http/https；15s 超时；20MB 上限；校验 Content-Type 为 image/*；
// 缓存 os.UserCacheDir()/quail/（key = sha256(url)），原子写入，命中直回。

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"golang.org/x/sync/singleflight"
)

const (
	imgProxyPrefix    = "/__imgproxy/"
	remoteMaxBytes    = 20 << 20 // 20MB
	remoteHTTPTimeout = 15 * time.Second
)

var imgFlight singleflight.Group

// ImgProxyMiddleware 返回 AssetServer 中间件：命中代理路径则短路处理，
// 其余请求交给默认静态资源链。
func ImgProxyMiddleware(fs *FileService) application.Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !strings.HasPrefix(r.URL.Path, imgProxyPrefix) {
				next.ServeHTTP(w, r)
				return
			}
			switch {
			case strings.HasPrefix(r.URL.Path, imgProxyPrefix+"local"):
				serveLocal(w, r, fs)
			case strings.HasPrefix(r.URL.Path, imgProxyPrefix+"remote"):
				serveRemote(w, r)
			default:
				writeProxyError(w, http.StatusNotFound, "unknown proxy route")
			}
		})
	}
}

// serveLocal 本地文档目录图片（白名单 + 内容魔数双校验：仅放行真实图片）。
func serveLocal(w http.ResponseWriter, r *http.Request, fs *FileService) {
	docPath := fs.CurrentPath()
	if docPath == "" {
		writeProxyError(w, http.StatusForbidden, "document not saved")
		return
	}
	docDir := filepath.Dir(docPath)
	docName := filepath.Base(docPath)

	raw := strings.TrimSpace(r.URL.Query().Get("p"))
	if raw == "" {
		writeProxyError(w, http.StatusBadRequest, "missing p")
		return
	}
	var target string
	if filepath.IsAbs(raw) {
		target = filepath.Clean(raw)
	} else {
		target = filepath.Clean(filepath.Join(docDir, raw))
	}

	// 白名单：仅允许 [FILE_DIR]/*（直接文件）、[FILE_DIR]/assets/** 和
	// [FILE_DIR]/[FILE_NAME].assets/** 内的资源；其余子目录一律 403。
	if !isAllowedLocalTarget(runtime.GOOS, docDir, docName, target) {
		writeProxyError(w, http.StatusForbidden, "access restricted")
		return
	}
	// 软链接逃逸兜底：真实路径解析后仍须在白名单内
	if resolved, err := filepath.EvalSymlinks(target); err == nil && resolved != target {
		if !isAllowedLocalTarget(runtime.GOOS, docDir, docName, resolved) {
			writeProxyError(w, http.StatusForbidden, "access restricted")
			return
		}
	}

	data, err := os.ReadFile(target)
	if err != nil {
		if os.IsNotExist(err) {
			writeProxyError(w, http.StatusNotFound, "file not found")
		} else {
			writeProxyError(w, http.StatusInternalServerError, "read failed")
		}
		return
	}
	if !isImageContent(data) {
		writeProxyError(w, http.StatusForbidden, "not an image")
		return
	}
	w.Header().Set("Content-Type", sniffImageContentType(data))
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(data)
}

// serveRemote 远程图片：缓存命中直回，未命中下载后写缓存。
func serveRemote(w http.ResponseWriter, r *http.Request) {
	rawURL := strings.TrimSpace(r.URL.Query().Get("url"))
	if rawURL == "" {
		// 空链接校验（与前端 md-image 拦截互为纵深）：url 为空或全空白
		// 直接 400，不进入缓存键计算与上游下载
		writeProxyError(w, http.StatusBadRequest, "missing url")
		return
	}
	u, err := url.Parse(rawURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		writeProxyError(w, http.StatusBadRequest, "invalid url")
		return
	}

	cacheDir := imgCacheDir()
	// 缓存键 = sha256(url)（不带扩展名）：URL 扩展名与实际格式常不一致
	// （无扩展名/伪扩展名），Content-Type 统一由内容魔数嗅探决定
	cachePath := filepath.Join(cacheDir, "imgs", sha256HexStr(rawURL))
	// refresh=1（前端刷新按钮）：跳过缓存读取，强制重新下载并覆盖缓存
	if r.URL.Query().Get("refresh") != "1" {
		if data, err := os.ReadFile(cachePath); err == nil {
			w.Header().Set("Content-Type", sniffImageContentType(data))
			w.Header().Set("Cache-Control", "max-age=86400")
			_, _ = w.Write(data)
			return
		}
	}

	// singleflight：并发请求同一 URL 只下载一次
	v, err, _ := imgFlight.Do(rawURL, func() (any, error) {
		return downloadToCache(u, cachePath)
	})
	if err != nil {
		// 上游 404（有权访问但目标图片不存在）→ 透传 404；上游 401/403
		// （防盗链/禁止外链）→ 透传 403，前端均据状态码归类占位文案，
		// 与通用下载失败(502)区分。
		if errors.Is(err, errUpstreamNotFound) {
			writeProxyError(w, http.StatusNotFound, "remote image not found")
		} else if errors.Is(err, errUpstreamForbidden) {
			writeProxyError(w, http.StatusForbidden, "remote image forbidden")
		} else {
			writeProxyError(w, http.StatusBadGateway, "download failed")
		}
		return
	}
	w.Header().Set("Content-Type", sniffImageContentType(v.([]byte)))
	w.Header().Set("Cache-Control", "max-age=86400")
	_, _ = w.Write(v.([]byte))
}

// errUpstreamNotFound 上游明确返回 404：目标图片不存在（非网络/网关故障）。
var errUpstreamNotFound = errors.New("upstream not found")

// errUpstreamForbidden 上游拒绝访问（401/403，常见于防盗链/外链禁止）：
// 归类为「访问受限」，前端展示受限占位。
var errUpstreamForbidden = errors.New("upstream forbidden")

// downloadToCache 下载远程图片并原子写缓存。
func downloadToCache(u *url.URL, cachePath string) ([]byte, error) {
	client := &http.Client{Timeout: remoteHTTPTimeout}
	resp, err := client.Get(u.String())
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil, errUpstreamNotFound
	}
	if resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusUnauthorized {
		return nil, errUpstreamForbidden
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("upstream status %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "" && !strings.HasPrefix(ct, "image/") {
		return nil, errors.New("not an image")
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, remoteMaxBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > remoteMaxBytes {
		return nil, errors.New("too large")
	}
	_ = os.MkdirAll(filepath.Dir(cachePath), 0o755)
	if err := writeFileAtomic(cachePath, data, 0o644); err != nil {
		// 缓存写失败不阻塞响应（内存直回）
		return data, nil
	}
	return data, nil
}

// imgCacheDir 系统缓存目录：os.UserCacheDir()/quail。
func imgCacheDir() string {
	base, err := os.UserCacheDir()
	if err != nil {
		base = os.TempDir()
	}
	return filepath.Join(base, "quail")
}

// pathWithinDirOn 判定 target 是否落在 dir 内（含 dir 本身）。
// 用 filepath.Rel 做语义化包含判定：精确识别逃逸（../），不误杀文件名
// 含 ".." 的合法资源。goos 参数便于单元测试：windows 与 darwin 的默认
// 文件系统大小写不敏感，比较前折叠大小写与实际 FS 行为一致。
func pathWithinDirOn(goos, dir, target string) bool {
	if goos == "windows" || goos == "darwin" {
		dir = strings.ToLower(dir)
		target = strings.ToLower(target)
	}
	rel, err := filepath.Rel(dir, target)
	if err != nil {
		return false
	}
	return rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)))
}

// imageMagic 按内容魔数识别已知图片格式，返回 Content-Type。
// 命中任意一种已知图片格式 → (类型, true)；未识别 → ("", false)。
func imageMagic(data []byte) (string, bool) {
	switch {
	case len(data) >= 4 && data[0] == 0x89 && data[1] == 'P' && data[2] == 'N' && data[3] == 'G':
		return "image/png", true
	case len(data) >= 6 && (string(data[:6]) == "GIF87a" || string(data[:6]) == "GIF89a"):
		return "image/gif", true
	case len(data) >= 12 && string(data[:4]) == "RIFF" && string(data[8:12]) == "WEBP":
		return "image/webp", true
	case len(data) >= 2 && data[0] == 'B' && data[1] == 'M':
		return "image/bmp", true
	case len(data) >= 4 && data[0] == 0x00 && data[1] == 0x00 && data[2] == 0x01 && data[3] == 0x00:
		return "image/x-icon", true
	case len(data) >= 12 && string(data[4:8]) == "ftyp" && (string(data[8:12]) == "avif" || string(data[8:12]) == "avis"):
		return "image/avif", true
	case isSVGData(data):
		return "image/svg+xml", true
	case len(data) >= 3 && data[0] == 0xFF && data[1] == 0xD8 && data[2] == 0xFF:
		return "image/jpeg", true
	default:
		return "", false
	}
}

// sniffImageContentType 按内容魔数判定图片 Content-Type。
// 远程图片的 URL 扩展名与实际格式常不一致（无扩展名/伪扩展名），
// 按扩展名回 Content-Type 会错标（如 SVG 被标成 image/jpeg 拒渲染）。
// 调用方须先用 isImageContent 校验（本地代理如此），否则未识别内容
// 落入 jpeg 兜底。
func sniffImageContentType(data []byte) string {
	if ct, ok := imageMagic(data); ok {
		return ct
	}
	return "image/jpeg" // 兜底（jpeg 魔数较宽松，x-doom 等罕见格式不细分）
}

// isImageContent 严格判定数据是否为已知图片格式（无兜底）：任何未识别
// 内容一律 false。本地代理（serveLocal / resolveLocalTarget）据此拒绝
// 白名单目录内的非图片文件，与远程代理"必须为图片"口径统一。
func isImageContent(data []byte) bool {
	_, ok := imageMagic(data)
	return ok
}

// isImageFile 按文件头魔数判定磁盘文件是否为图片（只读前 4KB 嗅探，
// 不整读大文件）。
func isImageFile(path string) bool {
	fh, err := os.Open(path)
	if err != nil {
		return false
	}
	defer fh.Close()
	head := make([]byte, 4096)
	n, err := io.ReadFull(fh, head)
	if err != nil && err != io.ErrUnexpectedEOF && err != io.EOF {
		return false
	}
	return isImageContent(head[:n])
}

// isSVGData 宽容识别 SVG 文本（允许 BOM / 前置空白 / <?xml 头）。
func isSVGData(data []byte) bool {
	s := bytes.TrimLeft(data, " \t\r\n")
	if bytes.HasPrefix(s, []byte{0xEF, 0xBB, 0xBF}) {
		s = bytes.TrimLeft(s[3:], " \t\r\n")
	}
	return bytes.HasPrefix(s, []byte("<svg")) || bytes.HasPrefix(s, []byte("<?xml"))
}

// sha256HexStr 字节串 sha256 hex 编码。
func sha256HexStr(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// writeProxyError JSON 错误响应（前端 md-image error 态展示）。
func writeProxyError(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

// companionAssetsNames 返回文档对应的伴生资产目录候选名（不含路径）：
//   - 仅 markdown 文档（.md / .markdown）适用
//   - 候选固定为三种：[BASE].md.assets、[BASE].assets、[BASE].markdown.assets
//     其中 [BASE] 为去掉 .md / .markdown 扩展名的文件名
//   - 非 markdown 文档（含无扩展名、.txt 等）返回 nil，不接受任何伴生目录
//
// 扩展名判断按大小写折叠进行（Note.MD 同样识别），[BASE] 保留原大小写，
// 由调用方按 GOOS 折叠比较。
func companionAssetsNames(docName string) []string {
	ext := filepath.Ext(docName)
	if ext == "" || len(docName) <= len(ext) {
		return nil
	}
	lowerExt := strings.ToLower(ext)
	if lowerExt != ".md" && lowerExt != ".markdown" {
		return nil
	}
	base := docName[:len(docName)-len(ext)]
	return []string{
		base + ".md.assets",
		base + ".assets",
		base + ".markdown.assets",
	}
}

// isAllowedLocalTarget 判定 target 是否落在本地代理白名单内：
//   - [FILE_DIR]/*                       直接位于文档目录下的文件
//   - [FILE_DIR]/assets/**               资产目录内（含嵌套）
//   - [FILE_DIR]/[FILE_NAME].assets/**   文档伴生资产目录内（含嵌套），
//     [FILE_NAME] 可为完整文件名，markdown
//     文档亦可为去扩展名形式
//
// 其他子目录一律拒绝。goos 参数便于单元测试：windows / darwin 的
// 默认文件系统大小写不敏感，比较目录名时按实际 FS 行为折叠大小写。
func isAllowedLocalTarget(goos, docDir, docName, target string) bool {
	rel, err := filepath.Rel(docDir, target)
	if err != nil || rel == "." {
		return false // 目录本身不可作为图片
	}
	sep := string(filepath.Separator)
	// 逃逸拦截（Clean 之后仍可能出现 ".." 段）
	if rel == ".." || strings.HasPrefix(rel, ".."+sep) {
		return false
	}
	fold := func(s string) string {
		if goos == "windows" || goos == "darwin" {
			return strings.ToLower(s)
		}
		return s
	}
	parts := strings.Split(rel, sep)
	// [FILE_DIR]/*：直接子项（目录本身会在 ReadFile 失败，无需在此区分）
	if len(parts) == 1 {
		return true
	}
	// 子目录内：仅 assets/ 与 [FILE_NAME].assets/
	sub := fold(parts[0])
	if sub == "assets" {
		return true
	}
	for _, name := range companionAssetsNames(docName) {
		if sub == fold(name) {
			return true
		}
	}
	return false
}
