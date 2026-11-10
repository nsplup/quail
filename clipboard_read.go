package main

// ClipboardRead：粘贴链路的剪贴板后端读取（FileService 绑定方法）。
//
// 粘贴事件不再经前端 ClipboardEvent 读取剪贴板数据：前端只调用本方法，
// 剪贴板探测与校验（含图片魔数 / 大小）全部在后端完成，统一 payload 返回。
//
// 图片落盘分两步（为避免"无文档路径时后端落盘失败 / 前端只拿到 error"）：
//   - ReadClipboard：校验通过后暂存到内存单槽（PendingID 标识），返回 ok=true；
//   - CommitClipboardImage：前端路径守卫通过后回传 PendingID，由后端读取
//     文档资产目录并落盘，返回 ImportedImage（命名 img-<hash>，见 saveImageBytes）。
// 未落盘时（用户取消保存 / TTL 过期 / 后续粘贴覆盖槽位）不产生任何文件。
//
//   - kind=image：FmtImage 恒为 PNG 编码字节。魔数校验失败（SVG / 非图片）
//     → reason=format；超过 20MB → reason=size；通过 → 暂存并携带 PendingID；
//   - kind=html：text/html 与 text/plain 同时返回（html 非空）；
//   - kind=text：仅纯文本；
//   - kind=empty：剪贴板无可消费内容（ErrNoData / 基础设施不可用，
//     后者记录日志后同样按 empty 处理）。

import (
	"context"
	"errors"
	"log"
	"sync"
	"time"

	"golang.design/x/clipboard"
)

// ClipboardPayload ReadClipboard 返回的统一 payload（前端按 kind 分派）。
type ClipboardPayload struct {
	Kind      string `json:"kind"`                // image | html | text | empty
	Ok        bool   `json:"ok"`                  // image 分支：校验是否通过
	PendingID uint64 `json:"pendingId,omitempty"` // image&ok：暂存槽位标识，Commit 时回传
	HTML      string `json:"html,omitempty"`      // text/html 内容
	Text      string `json:"text,omitempty"`      // text/plain 内容
	Reason    string `json:"reason,omitempty"`    // image 校验失败原因：format | size
}

// clipboardMaxImageBytes 图片数据大小上限（口径：超过 20MB 丢弃）。
const clipboardMaxImageBytes = 20 * 1024 * 1024

// clipboardReadTimeout 单次剪贴板读取超时（选区协商可能跨进程往返）。
const clipboardReadTimeout = 10 * time.Second

// pendingImageTTL 粘贴图片暂存有效期（覆盖用户在保存对话框上的决策窗口）。
const pendingImageTTL = 5 * time.Minute

var (
	clipboardInitOnce   sync.Once
	clipboardInitErr    error
	clipboardHTMLFormat clipboard.Format
)

// pendingClipboardImage 粘贴图片内存暂存槽（单槽位：粘贴由前端串行触发）。
// ReadClipboard 只校验 + 暂存，CommitClipboardImage 单次消费。
var pendingClipboardImage struct {
	mu   sync.Mutex
	seq  uint64
	id   uint64
	data []byte
	at   time.Time
}

// initClipboard 幂等初始化：Init + 注册 text/html 自定义格式。
func initClipboard() error {
	clipboardInitOnce.Do(func() {
		if clipboardInitErr = clipboard.Init(); clipboardInitErr != nil {
			return
		}
		clipboardHTMLFormat = clipboard.Register("text/html")
	})
	return clipboardInitErr
}

// ReadClipboard 粘贴链路统一入口：探测剪贴板内容并按种类返回 payload。
// 图片只做校验 + 暂存（不落盘，不依赖文档路径）；落盘由前端路径守卫通过后
// 调用 CommitClipboardImage 完成。
func (f *FileService) ReadClipboard() (*ClipboardPayload, error) {
	if err := initClipboard(); err != nil {
		log.Printf("clipboard init: %v", err)
		return &ClipboardPayload{Kind: "empty"}, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), clipboardReadTimeout)
	defer cancel()

	// 1. 图片：FmtImage 恒为 PNG 编码字节；命中即校验 + 内存暂存
	if data, err := clipboard.Read(ctx, clipboard.FmtImage); err == nil && len(data) > 0 {
		return stashClipboardImage(data), nil
	} else if err != nil {
		log.Printf("clipboard read image: %v", err)
	}

	// 2. text/html（来源程序提供该格式时才有值）
	html := readClipboardString(ctx, clipboardHTMLFormat)

	// 3. text/plain
	text := readClipboardString(ctx, clipboard.FmtText)

	switch {
	case html != "":
		return &ClipboardPayload{Kind: "html", HTML: html, Text: text}, nil
	case text != "":
		return &ClipboardPayload{Kind: "text", Text: text}, nil
	default:
		return &ClipboardPayload{Kind: "empty"}, nil
	}
}

// CommitClipboardImage 将 ReadClipboard 暂存的图片落盘到当前文档资产目录。
// 无暂存 / ID 不匹配（已被后续粘贴覆盖）/ 超过 TTL → error；
// 无文档路径 → assetsDirForInsert 的 error（前端已先过路径守卫，此为兜底）。
func (f *FileService) CommitClipboardImage(pendingID uint64) (*ImportedImage, error) {
	data, err := takePendingClipboardImage(pendingID)
	if err != nil {
		return nil, err
	}
	assetsDir, err := f.assetsDirForInsert()
	if err != nil {
		return nil, err
	}
	img, ok := saveImageBytes(assetsDir, data, "")
	if !ok {
		return nil, errors.New("invalid image data")
	}
	return img, nil
}

// stashClipboardImage 图片校验 + 内存暂存（不落盘）。
func stashClipboardImage(data []byte) *ClipboardPayload {
	if len(data) > clipboardMaxImageBytes {
		return &ClipboardPayload{Kind: "image", Reason: "size"}
	}
	ct, ok := imageMagic(data)
	if !ok || ct == "image/svg+xml" || extFromImageContentType(ct) == "" {
		return &ClipboardPayload{Kind: "image", Reason: "format"}
	}
	pendingClipboardImage.mu.Lock()
	pendingClipboardImage.seq++
	id := pendingClipboardImage.seq
	pendingClipboardImage.id = id
	pendingClipboardImage.data = data
	pendingClipboardImage.at = time.Now()
	pendingClipboardImage.mu.Unlock()
	return &ClipboardPayload{Kind: "image", Ok: true, PendingID: id}
}

// takePendingClipboardImage 单次消费暂存槽：ID 匹配 + TTL 内才返回数据。
func takePendingClipboardImage(pendingID uint64) ([]byte, error) {
	pendingClipboardImage.mu.Lock()
	defer pendingClipboardImage.mu.Unlock()
	if pendingClipboardImage.id != pendingID || len(pendingClipboardImage.data) == 0 {
		return nil, errors.New("pending clipboard image missing or superseded")
	}
	if time.Since(pendingClipboardImage.at) > pendingImageTTL {
		pendingClipboardImage.data = nil
		return nil, errors.New("pending clipboard image expired")
	}
	data := pendingClipboardImage.data
	pendingClipboardImage.data = nil
	return data, nil
}

// readClipboardString 读取文本类格式（读取失败 / 空内容一律返回空串）。
func readClipboardString(ctx context.Context, format clipboard.Format) string {
	data, err := clipboard.Read(ctx, format)
	if err != nil || len(data) == 0 {
		if err != nil && format != clipboard.FmtText {
			log.Printf("clipboard read %s: %v", format, err)
		}
		return ""
	}
	return string(data)
}
