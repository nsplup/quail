package main

// ClipboardService：原生剪贴板写入。
//
// webkitgtk 下 navigator.clipboard.writeText 受手势上下文限制（CM6 选区代理
// 的选区变化事件不在用户手势内），改由后端走跨平台原生剪贴板。

import (
	"context"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// ClipboardService 服务。
type ClipboardService struct {
	app *application.App
}

// NewClipboardService 构造函数。
func NewClipboardService() *ClipboardService {
	return &ClipboardService{}
}

// ServiceStartup 生命周期钩子：持有 App 引用。
func (c *ClipboardService) ServiceStartup(context.Context, application.ServiceOptions) error {
	c.app = application.Get()
	return nil
}

// SetText 写入文本到系统剪贴板，返回是否成功。
func (c *ClipboardService) SetText(text string) bool {
	return c.app.Clipboard.SetText(text)
}

// ReadText 读取系统剪贴板文本（webkitgtk 下前端 paste 事件剪贴板数据
// 偶发为空时的兜底读取通道）。beta.26 的 ClipboardManager 读方法为
// Text() (string, bool)，读取失败返回空串。
func (c *ClipboardService) ReadText() string {
	text, ok := c.app.Clipboard.Text()
	if !ok {
		return ""
	}
	return text
}
