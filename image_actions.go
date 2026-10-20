package main

// ImageActions：图片右键菜单的后端支撑（FileService 绑定方法）。
//
// 前端 <md-image> 右键菜单（仅 loaded 态可用）的三个动作落到后端：
//   - 使用外部程序打开：ImageFilePath 把 imgproxy 代理 URL 解析为磁盘文件
//     绝对路径（local = 白名单内的目标文件；remote = 代理缓存文件，未命中
//     缓存时先经 singleflight 下载缓存再返回），前端再以 wails runtime
//     Browser.OpenFile(path) 交系统默认程序打开；
//   - 另存为：PickImageSave 弹图片格式保存对话框选定目标路径，
//     ImageSaveFile 由后端读取源文件字节并原子写入（字节不经前端往返，
//     复用 writeFileAtomic 保障写入完整性）；
//
// 代理 URL 口径与 ImgProxyMiddleware 完全一致：
//   /__imgproxy/local?p=<相对或绝对路径>   /__imgproxy/remote?url=<encoded URL>
// （可携带 cb/refresh 穿透参数，解析时忽略 query 中多余键值）。

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// ImageFilePath 解析 imgproxy 代理 URL 为磁盘文件路径（外部程序打开用）。
// remote 未命中缓存时先下载缓存，确保返回路径可直接交给系统打开。
func (f *FileService) ImageFilePath(proxySrc string) (string, error) {
	return resolveProxyTarget(f, proxySrc)
}

// PickImageSave 弹出系统"保存图片"对话框（图片格式过滤器），返回目标路径
// （取消返回空串）。
func (f *FileService) PickImageSave(defaultName string) (string, error) {
	app := application.Get()
	if app == nil {
		return "", nil
	}
	if defaultName == "" {
		defaultName = "image.png"
	}
	return app.Dialog.SaveFile().
		SetMessage("另存为").
		SetFilename(defaultName).
		AddFilter("Image", "*.png;*.jpg;*.jpeg;*.gif;*.webp;*.svg;*.bmp;*.ico;*.avif").
		AddFilter("All files", "*.*").
		PromptForSingleSelection()
}

// ImageSaveFile 把 imgproxy 代理 URL 指向的图片写入 destPath（另存为用）。
// 源字节经 resolveProxyTarget 定位后整读，再原子写目标路径。
func (f *FileService) ImageSaveFile(proxySrc string, destPath string) (bool, error) {
	src, err := resolveProxyTarget(f, proxySrc)
	if err != nil {
		return false, err
	}
	dest := strings.TrimSpace(destPath)
	if dest == "" {
		return false, errors.New("empty dest path")
	}
	data, err := os.ReadFile(src)
	if err != nil {
		return false, err
	}
	if err := writeFileAtomic(dest, data, 0o644); err != nil {
		return false, err
	}
	return true, nil
}

func (f *FileService) OpenFileWithExternal(filePath string) error {
	// 通过 application.Get() 获取应用实例来访问 Browser 管理器
	app := application.Get()
	return app.Browser.OpenFile(filePath)
}

// resolveProxyTarget 解析 imgproxy 代理 URL 为磁盘文件路径。
//
// local：与 serveLocal 同口径——文档目录白名单（filepath.Rel 语义化包含判定，
// 软链接逃逸兜底），返回目标绝对路径；
// remote：返回缓存文件路径（os.UserCacheDir()/quail/imgs/<sha256(url)>），
// 未命中时经 imgFlight（与 serveRemote 同一 singleflight 组）下载缓存。
func resolveProxyTarget(f *FileService, proxySrc string) (string, error) {
	if !strings.HasPrefix(proxySrc, imgProxyPrefix) {
		return "", errors.New("not an imgproxy url")
	}
	u, err := url.Parse(proxySrc)
	if err != nil {
		return "", fmt.Errorf("parse proxy url: %w", err)
	}
	switch {
	case strings.HasPrefix(u.Path, imgProxyPrefix+"local"):
		return resolveLocalTarget(f, u.Query().Get("p"))
	case strings.HasPrefix(u.Path, imgProxyPrefix+"remote"):
		return resolveRemoteTarget(u.Query().Get("url"))
	default:
		return "", errors.New("unknown proxy route")
	}
}

// resolveLocalTarget 本地资源解析（白名单与软链接逃逸校验同 serveLocal）。
func resolveLocalTarget(f *FileService, raw string) (string, error) {
	docPath := f.CurrentPath()
	if docPath == "" {
		return "", errors.New("document not saved")
	}
	docDir := filepath.Dir(docPath)

	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", errors.New("missing p")
	}
	var target string
	if filepath.IsAbs(raw) {
		target = filepath.Clean(raw)
	} else {
		target = filepath.Clean(filepath.Join(docDir, raw))
	}

	// 白名单：与 serveLocal 一致（语义化包含判定，防 ../ 逃逸）
	if !pathWithinDirOn(runtime.GOOS, docDir, target) {
		return "", errors.New("access restricted")
	}
	// 软链接逃逸兜底：真实路径解析后仍须在白名单内
	if resolved, err := filepath.EvalSymlinks(target); err == nil && resolved != target {
		if !pathWithinDirOn(runtime.GOOS, docDir, resolved) {
			return "", errors.New("access restricted")
		}
	}
	if _, err := os.Stat(target); err != nil {
		if os.IsNotExist(err) {
			return "", errors.New("file not found")
		}
		return "", err
	}
	return target, nil
}

// resolveRemoteTarget 远程资源解析：返回缓存路径；未命中缓存时下载
// （与 serveRemote 同一 singleflight 组，并发解析/请求只下载一次）。
func resolveRemoteTarget(rawURL string) (string, error) {
	rawURL = strings.TrimSpace(rawURL)
	if rawURL == "" {
		return "", errors.New("missing url")
	}
	u, err := url.Parse(rawURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return "", errors.New("invalid url")
	}
	// 缓存键与 serveRemote 一致：sha256(url)（不带扩展名）
	cachePath := filepath.Join(imgCacheDir(), "imgs", sha256HexStr(rawURL))
	if _, err := os.Stat(cachePath); err == nil {
		return cachePath, nil
	}
	_, err, _ = imgFlight.Do(rawURL, func() (any, error) {
		return downloadToCache(u, cachePath)
	})
	if err != nil {
		return "", err
	}
	return cachePath, nil
}
