package main

// ConfigService：配置读取 / 持久化 / 监听。
//
// - 配置目录：系统全局 os.UserConfigDir()/quail（Linux ~/.config/quail、
//   macOS ~/Library/Application Support/quail、Windows %AppData%/quail）；
// - 持久化：settings.json 原子写；
// - 监听：fsnotify 监听配置目录，settings.json 被外部修改（含用户手改）时
//   防抖后 emit config:changed 并携带新配置；
// - 前端设置以这里为唯一事实源（localStorage 只做旧版一次性迁移）。

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// Config 前端设置快照（字段与前端 store 一一对应）。
type Config struct {
	Mode           string   `json:"mode"`           // editor | split | preview
	Theme          string   `json:"theme"`          // ThemeId
	Locale         string   `json:"locale"`         // zh | en
	Indent         string   `json:"indent"`         // IndentId
	CountMode      string   `json:"countMode"`      // CountMode
	FontEditor     string   `json:"fontEditor"`
	FontPreview    string   `json:"fontPreview"`
	FontSizeEditor float64  `json:"fontSizeEditor"`
	FontSizePreview float64 `json:"fontSizePreview"`
	SelectionProxy bool     `json:"selectionProxy"`
	RecentFiles    []string `json:"recentFiles"`
}

// defaultConfig 出厂默认值。
func defaultConfig() Config {
	return Config{
		Mode:            "split",
		Theme:           "ayu-dark",
		Locale:          "zh",
		Indent:          "2",
		CountMode:       "chars",
		FontEditor:      "",
		FontPreview:     "",
		FontSizeEditor:  14,
		FontSizePreview: 16,
		SelectionProxy:  true,
		RecentFiles:     []string{},
	}
}

// settingsFile 配置文件名。
const settingsFile = "settings.json"

// ConfigService 服务。
type ConfigService struct {
	mu      sync.Mutex
	cfg     Config
	dir     string
	watcher *fsnotify.Watcher
	quit    chan struct{}
	// suppress 自身写入抑制标记（Save → watch 回环）
	suppress bool
}

// 包级单例：FileService 记录最近文件时引用。
var configSvc = NewConfigService()

// NewConfigService 构造（目录初始化在 ServiceStartup）。
func NewConfigService() *ConfigService {
	return &ConfigService{cfg: defaultConfig()}
}

// ServiceStartup 加载配置 + 启动目录监听。
func (c *ConfigService) ServiceStartup(context.Context, application.ServiceOptions) error {
	dir, err := os.UserConfigDir()
	if err != nil {
		return err
	}
	c.dir = filepath.Join(dir, "quail")
	_ = os.MkdirAll(c.dir, 0o755)

	c.mu.Lock()
	c.cfg = c.loadLocked()
	err = c.startWatchLocked()
	c.mu.Unlock()
	return err
}

// ServiceShutdown 停止监听。
func (c *ConfigService) ServiceShutdown() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.quit != nil {
		close(c.quit)
		c.quit = nil
	}
	if c.watcher != nil {
		c.watcher.Close()
		c.watcher = nil
	}
}

// ConfigExists 判断磁盘上是否已存在配置文件（前端一次性迁移 localStorage 用）。
func (c *ConfigService) ConfigExists() bool {
	_, err := os.Stat(c.path())
	return err == nil
}

// Get 返回当前配置。
func (c *ConfigService) Get() Config {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.cfg
}

// Save 持久化配置（原子写），随后 watch 会因抑制而不重复广播；
// 前端主动保存的场景由调用方自行按需更新 UI。
func (c *ConfigService) Save(cfg Config) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.cfg = cfg
	raw, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	c.suppress = true
	defer time.AfterFunc(500*time.Millisecond, func() {
		c.mu.Lock()
		c.suppress = false
		c.mu.Unlock()
	})
	return writeFileAtomic(filepath.Join(c.dir, settingsFile), raw, 0o644)
}

// AddRecentFile 记录最近文件（去重、最新在前、上限 10）。
func (c *ConfigService) AddRecentFile(path string) {
	c.mu.Lock()
	cfg := c.cfg
	kept := cfg.RecentFiles[:0:0]
	for _, p := range cfg.RecentFiles {
		if p != path {
			kept = append(kept, p)
		}
	}
	cfg.RecentFiles = append([]string{path}, kept...)
	if len(cfg.RecentFiles) > 10 {
		cfg.RecentFiles = cfg.RecentFiles[:10]
	}
	c.cfg = cfg
	c.mu.Unlock()
	_ = c.Save(cfg)
}

// path 配置文件路径（ServiceStartup 之后有效）。
func (c *ConfigService) path() string {
	if c.dir == "" {
		return settingsFile
	}
	return filepath.Join(c.dir, settingsFile)
}

// loadLocked 从磁盘加载；损坏/缺失回退默认值。必须持 c.mu。
func (c *ConfigService) loadLocked() Config {
	raw, err := os.ReadFile(c.path())
	if err != nil {
		return defaultConfig()
	}
	cfg := defaultConfig()
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return defaultConfig()
	}
	return cfg
}

// startWatchLocked 监听配置目录，settings.json 变动 → 广播。必须持 c.mu。
func (c *ConfigService) startWatchLocked() error {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}
	if err := w.Add(c.dir); err != nil {
		w.Close()
		return err
	}
	c.watcher = w
	c.quit = make(chan struct{})

	go func() {
		var fireTimer *time.Timer
		fire := func() {
			c.mu.Lock()
			if c.suppress {
				c.mu.Unlock()
				return
			}
			c.cfg = c.loadLocked() // 以磁盘为准
			cfg := c.cfg
			c.mu.Unlock()
			emit(EventConfigChanged, ConfigEventData{Config: cfg})
		}
		for {
			select {
			case <-c.quit:
				return
			case ev, ok := <-w.Events:
				if !ok {
					return
				}
				if filepath.Base(ev.Name) != settingsFile {
					continue
				}
				if ev.Has(fsnotify.Remove) || ev.Has(fsnotify.Rename) {
					continue // 删除/换名不广播，等待重新创建
				}
				if fireTimer != nil {
					fireTimer.Stop()
				}
				fireTimer = time.AfterFunc(300*time.Millisecond, fire)
			case <-w.Errors:
			}
		}
	}()
	return nil
}
