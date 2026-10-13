// Package main —— quail 桌面壳（Wails v3）。
//
// 组装：
//   - AssetServer Middleware：ImgProxy（/__imgproxy/* 路径），其余请求走默认静态资源链；
//   - Services：AppService / FileService / ConfigService（导出方法自动绑定到前端）；
//   - 主窗口以 Hidden 启动，前端首帧渲染完成后调用 AppService.Ready 显示；
//   - 窗口尺寸记忆（$XDG_STATE_HOME/quail）由窗口事件驱动（window_state.go）；
//   - 文件拖拽打开走 Wails File Drop 官方通道（EnableFileDrop + 窗口事件），
//     前端 data-file-drop-target 标注放置区；
//   - 脏状态关闭拦截：ShouldQuit（应用级退出）+ WindowClosing 拦截钩子
//     （窗口关闭按钮）双通道，有未保存改动时取消关闭并通知前端弹 confirm。
//
// 事件名与 payload 模型集中在 events.go，枚举由 bindings 生成器自动产出 TS。
package main

import (
        "embed"
        "log"

        "github.com/wailsapp/wails/v3/pkg/application"
        "github.com/wailsapp/wails/v3/pkg/events"
)

//go:embed all:frontend/dist
var assets embed.FS

// appName 应用名：同时用于窗口标题、状态目录（$XDG_STATE_HOME/quail）等。
const appName = "quail"

// 包级服务实例：FileService 与 ConfigService 互相协作（配置广播）。
var (
        appSvc    = NewAppService()
        fileSvc   = NewFileService()
        configSvc = NewConfigService()
)

func main() {
        app := application.New(application.Options{
                Name: appName,
                Assets: application.AssetOptions{
                        Handler: application.AssetFileServerFS(assets),
                        Middleware: ImgProxyMiddleware(fileSvc),
                },
                Services: []application.Service{
                        application.NewService(appSvc),
                        application.NewService(fileSvc),
                        application.NewService(configSvc),
                },
                // 应用级关闭拦截（与下方 WindowClosing 拦截钩子构成完整关闭链）：
                // 窗口关闭按钮走 WindowClosing，Cmd+Q 等应用级退出走 ShouldQuit。
                // - 已确认退出或无脏状态 → 直接放行；
                // - 有脏状态 → ShouldQuit 立即返回 false 阻止退出，异步通知
                //   前端弹 confirm（close:request），确认后经 ConfirmQuit 退出时
                //   confirmed 已置位，此处放行。
                ShouldQuit: func() bool {
                        if appSvc.QuitConfirmed() || !appSvc.Dirty() {
                                return true
                        }
                        go appSvc.RequestClose()
                        return false
                },
        })

        winState := newWindowStateStore()
        winOpts := application.WebviewWindowOptions{
                Name:    "main",
                Title:   appName,
                Width:     1280,
                Height:    800,
                MinWidth:  720,
                MinHeight: 480,
                // 初始隐藏：前端首帧渲染完成调用 AppService.Ready 后再 Show，
                // 消除启动白屏/闪烁。
                Hidden: true,
                URL:    "/",
                // Wails File Drop：外部文件拖入窗口 → WindowFilesDropped 事件
                // （官方通道，见下方监听与 docs/features/drag-and-drop）。
                // Wails 会拦截外部文件拖拽（不会导航 webview），
                // 内部 HTML5 拖拽照常透传。
                EnableFileDrop: true,
        }
        // 恢复上次窗口尺寸（记录低于最小尺寸视为无效，回退出厂默认）
        if st := winState.Load(); st.Width >= winOpts.MinWidth && st.Height >= winOpts.MinHeight {
                winOpts.Width, winOpts.Height = st.Width, st.Height
        }
        win := app.Window.NewWithOptions(winOpts)

        // 窗口尺寸记忆：resize 事件 300ms 防抖持久化到 $XDG_STATE_HOME/quail；
        // 关闭时同步落盘兜底（防抖窗口内退出不丢最终尺寸）。
        win.OnWindowEvent(events.Common.WindowDidResize, func(ev *application.WindowEvent) {
                if w, h := win.Size(); w > 0 && h > 0 {
                        winState.Schedule(WindowState{Width: w, Height: h})
                }
        })
        win.OnWindowEvent(events.Common.WindowClosing, func(ev *application.WindowEvent) {
                if w, h := win.Size(); w > 0 && h > 0 {
                        winState.Flush(WindowState{Width: w, Height: h})
                }
        })

        // 窗口关闭拦截（参考 ref.go 实现思路）：有未保存改动时取消关闭，
        // 通知前端弹 confirm（close:request），由前端决定 ConfirmQuit 或取消。
        // 已确认退出（confirmed 置位）或无脏状态时直接放行。
        // 与 ShouldQuit 构成完整关闭链：窗口关闭按钮走这里，
        // Cmd+Q 等应用级退出走 ShouldQuit。
        win.RegisterHook(events.Common.WindowClosing, func(e *application.WindowEvent) {
                if appSvc.QuitConfirmed() || !appSvc.Dirty() {
                        return
                }
                e.Cancel()
                appSvc.RequestClose()
        })

        // 拖拽打开（Wails File Drop 官方通道）：前端在应用根元素标
        // data-file-drop-target（全窗口为放置区），放置后此事件携带全部
        // 文件绝对路径与目标元素信息 → 转发前端走标准打开流程装载
        // （后端不直接 Open：文档装载、脏状态与编辑器替换是前端职责）。
        win.OnWindowEvent(events.Common.WindowFilesDropped, func(ev *application.WindowEvent) {
                files := ev.Context().DroppedFiles()
                if len(files) == 0 {
                        return
                }
                payload := FileDroppedEventData{Files: files}
                if details := ev.Context().DropTargetDetails(); details != nil {
                        payload.Target = details.ElementID
                }
                emit(EventFileDropped, payload)
        })

        if err := app.Run(); err != nil {
                log.Fatal(err)
        }
}
