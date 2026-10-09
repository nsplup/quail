// Package main —— quail 桌面壳（Wails v3）。
//
// 组装：
//   - AssetServer Middleware：ImgProxy（/__imgproxy/* 路径），其余请求走默认静态资源链；
//   - Services：AppService / FileService / ConfigService（导出方法自动绑定到前端）；
//   - 主窗口以 Hidden 启动，前端首帧渲染完成后调用 AppService.Ready 显示。
//
// 事件名与 payload 模型集中在 events.go，枚举由 bindings 生成器自动产出 TS。
package main

import (
	"embed"
	"log"

	"github.com/wailsapp/wails/v3/pkg/application"
)

//go:embed all:frontend/dist
var assets embed.FS

// 包级服务实例：FileService 与 ConfigService 互相协作（最近文件、配置广播）。
var (
	appSvc  = NewAppService()
	fileSvc = NewFileService()
)

func main() {
	app := application.New(application.Options{
		Name: "quail",
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
			Middleware: ImgProxyMiddleware(fileSvc),
		},
		Services: []application.Service{
			application.NewService(appSvc),
			application.NewService(fileSvc),
			application.NewService(configSvc),
		},
	})

	app.NewWebviewWindowWithOptions(application.WebviewWindowOptions{
		Name:    "main",
		Title:   "quail",
		Width:     1280,
		Height:    800,
		MinWidth:  720,
		MinHeight: 480,
		// 初始隐藏：前端首帧渲染完成调用 AppService.Ready 后再 Show，
		// 消除启动白屏/闪烁。
		Hidden: true,
		URL:    "/",
	})

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
