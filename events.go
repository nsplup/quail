package main

import "github.com/wailsapp/wails/v3/pkg/application"

// 事件协议：事件名枚举 + payload 模型。
//
// EventType（命名类型 + 常量块）会被 wails3 generate bindings 自动生成
// TypeScript 枚举，无需任何注册（参考 v3 文档 features/bindings/enums）。
// 前端监听示例：
//   import { Events } from "@wailsio/runtime";
//   Events.On(EventType.FileChanged, (e) => { ... });

// EventType 全部后端 → 前端事件名。
type EventType string

const (
        // EventFileChanged 当前文档被外部修改；payload: FileEventData（Content 为
        // 转码后的 UTF-8 新内容，前端无需二次读取）。
        EventFileChanged EventType = "file:changed"
        // EventFileDeleted 当前文档被外部删除/移走；payload: FileEventData（无 Content）。
        EventFileDeleted EventType = "file:deleted"
        // EventConfigChanged 配置文件被外部修改或保存；payload: ConfigEventData。
        EventConfigChanged EventType = "config:changed"
        // EventCloseRequest RequestClose 触发的关闭请求；前端弹 confirm，
        // 确认后调用 AppService.ConfirmQuit。payload: nil。
        EventCloseRequest EventType = "close:request"
)

// FileEventData file:changed / file:deleted 的载荷。
type FileEventData struct {
        Path string `json:"path"`
        // Content 新内容（UTF-8）。deleted 事件为空。
        Content string `json:"content,omitempty"`
}

// ConfigEventData config:changed 的载荷。
type ConfigEventData struct {
        Config Config `json:"config"`
}

// emit 向前端广播事件。
func emit(name EventType, payload any) {
        app := application.Get()
        if app == nil {
                return
        }
        app.Event.Emit(string(name), payload)
}
