package main

// 窗口状态记忆：主窗口尺寸持久化到 $XDG_STATE_HOME/[APP_NAME]/window.json。
//
// - 状态目录遵循 XDG 规范：$XDG_STATE_HOME/quail，未设置时回退
//   ~/.local/state/quail（XDG 默认值）；
// - 与 settings.json（用户偏好，存 os.UserConfigDir）刻意分离：窗口几何
//   属于会话状态，不进配置事实源，也不会触发 config:changed 广播；
// - 持久化防抖 300ms：WindowDidResize 高频触发，合并为最后一次写入；
// - WindowClosing 时同步落盘兜底，避免防抖窗口内退出丢失最终尺寸。

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// windowStateFile 窗口状态文件名。
const windowStateFile = "window.json"

// WindowState 窗口几何快照。
type WindowState struct {
	Width  int `json:"width"`
	Height int `json:"height"`
}

// stateDir 会话状态目录：$XDG_STATE_HOME/[APP_NAME]，缺省 ~/.local/state/[APP_NAME]。
func stateDir() string {
	if root := os.Getenv("XDG_STATE_HOME"); root != "" {
		return filepath.Join(root, appName)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return appName // 极端环境（无 HOME）：退化为相对目录，不致崩溃
	}
	return filepath.Join(home, ".local", "state", appName)
}

// windowStateStore 窗口尺寸持久化（300ms 防抖写入）。
type windowStateStore struct {
	mu    sync.Mutex
	timer *time.Timer
}

func newWindowStateStore() *windowStateStore {
	return &windowStateStore{}
}

// Load 读取窗口状态；文件缺失/损坏/字段非法返回零值（调用方回退出厂默认）。
func (s *windowStateStore) Load() WindowState {
	raw, err := os.ReadFile(filepath.Join(stateDir(), windowStateFile))
	if err != nil {
		return WindowState{}
	}
	var st WindowState
	if json.Unmarshal(raw, &st) != nil {
		return WindowState{}
	}
	if st.Width <= 0 || st.Height <= 0 {
		return WindowState{}
	}
	return st
}

// Schedule 300ms 防抖后落盘：resize 连发期间反复重置定时器，静止 300ms
// 后只写一次最终尺寸。
func (s *windowStateStore) Schedule(st WindowState) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.timer != nil {
		s.timer.Stop()
	}
	s.timer = time.AfterFunc(300*time.Millisecond, func() {
		s.Flush(st)
	})
}

// Flush 取消挂起的防抖并立即同步落盘（窗口关闭时调用）。
func (s *windowStateStore) Flush(st WindowState) {
	s.mu.Lock()
	if s.timer != nil {
		s.timer.Stop()
		s.timer = nil
	}
	s.mu.Unlock()
	dir := stateDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return
	}
	raw, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return
	}
	_ = writeFileAtomic(filepath.Join(dir, windowStateFile), raw, 0o644)
}
