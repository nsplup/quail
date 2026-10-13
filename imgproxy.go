package main

// ImgProxy：图片请求代理（AssetServer Middleware）。
//
// 前端 <md-image data-src> 指向：
//   /__imgproxy/local?p=<相对或绝对路径>  —— 本地文档目录资源
//   /__imgproxy/remote?url=<encoded URL> —— 远程资源（下载 + 缓存）
//
// 本地白名单：已打开文档时，仅允许文档所在目录本身或其 assets/ 子目录下的
// 文件；文档未保存（未打开）、路径越权、路径逃逸（../）一律 403 JSON 错误，
// 前端 md-image 在 error 态展示"访问受限"。
//
// 远程：仅 http/https；15s 超时；20MB 上限；校验 Content-Type 为 image/*；
// 缓存 os.UserCacheDir()/quail/（key = sha256(url)），原子写入，命中直回。

import (
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

// serveLocal 本地文档目录图片。
func serveLocal(w http.ResponseWriter, r *http.Request, fs *FileService) {
        docPath := fs.CurrentPath()
        if docPath == "" {
                writeProxyError(w, http.StatusForbidden, "document not saved")
                return
        }
        docDir := filepath.Dir(docPath)

        raw := strings.TrimSpace(r.URL.Query().Get("p"))
        if raw == "" {
                // 空链接校验（与前端 md-image 拦截互为纵深）：p 为空或全空白
                // 直接 400，不触达文件系统（TrimSpace 前 raw 仅空白时会构造出
                // "文档目录/空白文件名" 这类无意义目标）
                writeProxyError(w, http.StatusBadRequest, "missing p")
                return
        }
        var target string
        if filepath.IsAbs(raw) {
                target = filepath.Clean(raw)
        } else {
                target = filepath.Clean(filepath.Join(docDir, raw))
        }

        // 白名单：target 必须落在文档目录内（assets/ 子目录天然包含）；
        // filepath.Clean 已消化相对段，这里再双重校验前缀与 .. 逃逸。
        if strings.Contains(raw, "..") ||
                (target != docDir && !strings.HasPrefix(target, docDir+string(filepath.Separator))) {
                writeProxyError(w, http.StatusForbidden, "access restricted")
                return
        }
        // 软链接逃逸兜底：真实路径解析后仍须在白名单内
        if resolved, err := filepath.EvalSymlinks(target); err == nil && resolved != target {
                if resolved != docDir && !strings.HasPrefix(resolved, docDir+string(filepath.Separator)) {
                        writeProxyError(w, http.StatusForbidden, "access restricted")
                        return
                }
        }

        data, err := os.ReadFile(target)
        if err != nil {
                // 语义细分：有权访问（白名单已通过）但目标文件不存在 → 404，
                // 前端 md-image error 态据状态码展示「图片不存在」；
                // 其他 IO 错误（权限外的读取失败等）→ 500 通用失败。
                if os.IsNotExist(err) {
                        writeProxyError(w, http.StatusNotFound, "file not found")
                } else {
                        writeProxyError(w, http.StatusInternalServerError, "read failed")
                }
                return
        }
        w.Header().Set("Content-Type", imageContentType(target))
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
        cachePath := filepath.Join(cacheDir, "imgs", sha256HexStr(rawURL)+cacheExt(u))
        // refresh=1（前端刷新按钮）：跳过缓存读取，强制重新下载并覆盖缓存
        if r.URL.Query().Get("refresh") != "1" {
                if data, err := os.ReadFile(cachePath); err == nil {
                        w.Header().Set("Content-Type", imageContentType(cachePath))
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
        w.Header().Set("Content-Type", imageContentType(cachePath))
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

// cacheExt 由 URL 猜缓存扩展名（serve 时据此回 Content-Type）。
func cacheExt(u *url.URL) string {
        switch {
        case strings.HasSuffix(u.Path, ".png"):
                return ".png"
        case strings.HasSuffix(u.Path, ".gif"):
                return ".gif"
        case strings.HasSuffix(u.Path, ".webp"):
                return ".webp"
        case strings.HasSuffix(u.Path, ".svg"):
                return ".svg"
        case strings.HasSuffix(u.Path, ".bmp"):
                return ".bmp"
        case strings.HasSuffix(u.Path, ".ico"):
                return ".ico"
        default:
                return ".jpg" // jpg/jpeg/未知
        }
}

// imageContentType 按扩展名给 Content-Type。
func imageContentType(path string) string {
        switch strings.ToLower(filepath.Ext(path)) {
        case ".png":
                return "image/png"
        case ".gif":
                return "image/gif"
        case ".webp":
                return "image/webp"
        case ".svg":
                return "image/svg+xml"
        case ".bmp":
                return "image/bmp"
        case ".ico":
                return "image/x-icon"
        case ".avif":
                return "image/avif"
        default:
                return "image/jpeg"
        }
}

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
