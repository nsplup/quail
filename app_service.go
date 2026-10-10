package main

// AppService：应用生命周期相关的最小服务面。
//
// - Ready：前端首帧渲染完成 → 显示主窗口（启动时 Hidden:true）；
// - HasUnsavedChanges：前端脏状态上报（脏状态事实源在前端），
//   为后续 WindowClosing 拦截钩子预留（本期不启用钩子）；
// - RequestClose：发起关闭请求 → emit close:request → 前端 confirm；
// - ConfirmQuit：前端确认后真正退出（此后不再有拦截）。

import (
	"context"
	"sync/atomic"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// AppService 服务。
type AppService struct {
	dirty atomic.Bool
}

// NewAppService 构造函数。
func NewAppService() *AppService {
	return &AppService{}
}

// ServiceStartup 生命周期钩子。
func (a *AppService) ServiceStartup(context.Context, application.ServiceOptions) error {
	return nil
}

// Ready 显示主窗口（前端首帧就绪后调用）。
func (a *AppService) Ready() {
	app := application.Get()
	if app == nil {
		return
	}
	if win, ok := app.Window.GetByName("main"); ok {
		win.Show()
	}
}

// SetTitle 同步窗口标题（与文档名联动；未命名文档由前端传 "untitled"）。
func (a *AppService) SetTitle(title string) {
	app := application.Get()
	if app == nil {
		return
	}
	if win, ok := app.Window.GetByName("main"); ok {
		win.SetTitle(title)
	}
}

// HasUnsavedChanges 前端上报当前脏状态。
func (a *AppService) HasUnsavedChanges(dirty bool) {
	a.dirty.Store(dirty)
}

// Dirty 读取脏状态（内部用，供关闭钩子/调试）。
func (a *AppService) Dirty() bool {
	return a.dirty.Load()
}

// RequestClose 请求关闭：通知前端弹 confirm，由前端决定 ConfirmQuit 或取消。
func (a *AppService) RequestClose() {
	emit(EventCloseRequest, nil)
}

// ConfirmQuit 前端确认关闭后调用：清理并退出。
func (a *AppService) ConfirmQuit() {
	app := application.Get()
	if app == nil {
		return
	}
	app.Quit()
}
