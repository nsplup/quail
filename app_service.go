package main

// AppService：应用生命周期相关的最小服务面。
//
// - Ready：前端首帧渲染完成 → 显示主窗口（启动时 Hidden:true）；
// - HasUnsavedChanges：前端脏状态上报（脏状态事实源在前端），
//   供 WindowClosing 拦截钩子与 ShouldQuit 关闭守卫读取；
// - RequestClose：发起关闭请求 → emit close:request → 前端 confirm；
// - ConfirmQuit：前端确认后置位 confirmed 并真正退出
//   （此后 WindowClosing / ShouldQuit 拦截全部放行，不再弹确认）；
// - CloseWindow：Ctrl+Q 快捷键入口，语义等同窗口关闭操作
//   （无脏状态直接退出；有脏状态走 close:request 脏状态守卫）；
// - NewInstance：Ctrl+N / 打开迁移入口，拉起新的 quail 进程实例。

import (
        "context"
        "os"
        "os/exec"
        "runtime"
        "strings"
        "sync/atomic"

        "github.com/wailsapp/wails/v3/pkg/application"
)

// AppService 服务。
type AppService struct {
        dirty     atomic.Bool // 前端上报的脏状态
        confirmed atomic.Bool // 前端已确认退出（ConfirmQuit 置位，拦截钩子据此放行）
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

// SetTitle 同步窗口标题（与文档名联动；未命名文档由前端按界面语言传入本地化文案）。
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

// Dirty 读取脏状态（内部用，供 WindowClosing 拦截钩子与 ShouldQuit）。
func (a *AppService) Dirty() bool {
        return a.dirty.Load()
}

// QuitConfirmed 前端是否已确认退出（内部用：拦截钩子据此放行退出）。
func (a *AppService) QuitConfirmed() bool {
        return a.confirmed.Load()
}

// RequestClose 请求关闭：通知前端弹 confirm，由前端决定 ConfirmQuit 或取消。
func (a *AppService) RequestClose() {
        emit(EventCloseRequest, nil)
}

// ConfirmQuit 前端确认关闭后调用：先置位确认标记（放行 WindowClosing /
// ShouldQuit 拦截），再清理并退出。
func (a *AppService) ConfirmQuit() {
        a.confirmed.Store(true)
        app := application.Get()
        if app == nil {
                return
        }
        app.Quit()
}

// CloseWindow Ctrl+Q 快捷键入口：语义等同窗口关闭操作（与 WindowClosing
// 拦截钩子同一关闭链）。
// - 已确认退出或无脏状态 → 直接退出（ShouldQuit 对无脏状态放行）；
// - 有脏状态 → RequestClose 触发 close:request → 前端弹脏状态守卫
//   confirm（保存/丢弃/取消），确认后经 ConfirmQuit 退出。
func (a *AppService) CloseWindow() {
        if a.QuitConfirmed() || !a.Dirty() {
                if app := application.Get(); app != nil {
                        app.Quit()
                }
                return
        }
        a.RequestClose()
}

// NewInstance 拉起一个新的 quail 进程实例（Ctrl+N / 打开迁移共用入口）。
// path 为空 → 新实例以未命名空文档启动；非空 → 新实例启动时装载该文件
// （复用 StartupDoc 的命令行参数通道，路径无效时新实例静默回落空文档）。
// 子进程脱离父进程独立运行，父实例退出不影响新实例。
func (a *AppService) NewInstance(path string) error {
        return spawnInstance(path)
}

// spawnInstance 以当前可执行文件启动新进程；path 作为首个命令行参数传入。
// macOS 下若运行于 .app 包内，改走 `open -n` 启动包本体（直接 exec 包内
// 二进制会绕过 Bundle 上下文），路径经 --args 透传。
func spawnInstance(path string) error {
        exe, err := os.Executable()
        if err != nil {
                return err
        }
        if runtime.GOOS == "darwin" && strings.Contains(exe, "/Contents/MacOS/") {
                bundle := exe[:strings.Index(exe, "/Contents/MacOS/")]
                args := []string{"-n", bundle}
                if path != "" {
                        args = append(args, "--args", path)
                }
                return exec.Command("open", args...).Start()
        }
        args := []string{}
        if path != "" {
                args = append(args, path)
        }
        return exec.Command(exe, args...).Start()
}
