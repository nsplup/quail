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
        Mode            string   `json:"mode"`           // editor | split | preview
        Theme           string   `json:"theme"`          // ThemeId
        Locale          string   `json:"locale"`         // zh | en
        Indent          string   `json:"indent"`         // IndentId
        CountMode       string   `json:"countMode"`      // CountMode
        FontEditor      string   `json:"fontEditor"`
        FontPreview     string   `json:"fontPreview"`
        FontSizeEditor  float64  `json:"fontSizeEditor"`
        FontSizePreview float64  `json:"fontSizePreview"`
}

// defaultConfig 出厂默认值。
func defaultConfig() Config {
        return Config{
                Mode:            "split",
                Theme:           "ayu-dark",
                Locale:          "zh",
                Indent:          "space2",
                CountMode:       "chars",
                FontEditor:      "",
                FontPreview:     "",
                FontSizeEditor:  14,
                FontSizePreview: 16,
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
        // guard 自身写入抑制登记簿（Save → watch 回环，写入令牌 + 内容哈希）
        guard *writeGuard
}

// NewConfigService 构造（目录初始化在 ServiceStartup）。
func NewConfigService() *ConfigService {
        return &ConfigService{cfg: defaultConfig(), guard: newWriteGuard()}
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

// Save 持久化配置（原子写）。落盘前登记写入令牌 + 内容哈希，watch 防抖
// 触发时以磁盘内容哈希核对令牌：命中 → 自身写入回环，抑制广播；未命中 →
// 外部修改，正常广播。前端主动保存的场景由调用方自行按需更新 UI。
func (c *ConfigService) Save(cfg Config) error {
        c.mu.Lock()
        defer c.mu.Unlock()
        c.cfg = cfg
        raw, err := json.MarshalIndent(cfg, "", "  ")
        if err != nil {
                return err
        }
        c.guard.begin(newWriteToken(), sha256Hex(raw))
        return writeFileAtomic(filepath.Join(c.dir, settingsFile), raw, 0o644)
}

// SaveFields 增量保存：仅合并前端提交的脏字段，其余字段以磁盘最新值为准。
//
// 多窗口/多实例场景下，各窗口前端各持一份配置快照；若整包回写，陈旧快照会
// 覆盖其他窗口刚落盘的字段，随后 config:changed 广播把旧值重放进正在编辑的
// 窗口，表现为设置"偶尔跳回原值"。因此这里：
//   - 落盘前重读磁盘（loadLocked）作为合并基准，最大限度收窄并发竞态窗口；
//   - 只覆盖提交的字段（忽略未知键），不携带快照里的陈旧字段；
//   - 落盘成功后直接广播 config:changed（同进程所有窗口即时同步；本次写入
//     已登记抑制令牌，watch 回环不会再触发第二次广播；跨进程实例仍由各自的
//     fsnotify watch 感知）。
func (c *ConfigService) SaveFields(fields map[string]any) error {
        c.mu.Lock()
        merged := c.loadLocked() // 磁盘为事实源（c.cfg 可能落后于 watch 防抖）
        if len(fields) > 0 {
                base, err := json.Marshal(merged)
                if err != nil {
                        c.mu.Unlock()
                        return err
                }
                var m map[string]any
                if err := json.Unmarshal(base, &m); err != nil {
                        c.mu.Unlock()
                        return err
                }
                for k, v := range fields {
                        if _, ok := m[k]; ok { // 只接受已知字段，防注入未知键
                                m[k] = v
                        }
                }
                raw, err := json.Marshal(m)
                if err != nil {
                        c.mu.Unlock()
                        return err
                }
                if err := json.Unmarshal(raw, &merged); err != nil {
                        c.mu.Unlock()
                        return err
                }
        }
        c.cfg = merged
        out, err := json.MarshalIndent(merged, "", "  ")
        if err != nil {
                c.mu.Unlock()
                return err
        }
        c.guard.begin(newWriteToken(), sha256Hex(out))
        err = writeFileAtomic(filepath.Join(c.dir, settingsFile), out, 0o644)
        c.mu.Unlock()
        if err == nil {
                emit(EventConfigChanged, ConfigEventData{Config: merged})
        }
        return err
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
                        raw, err := os.ReadFile(c.path())
                        if err != nil {
                                return
                        }
                        // 磁盘内容哈希命中登记写入 → 自身写入回环，抑制广播
                        if c.guard.claim(sha256Hex(raw)) {
                                return
                        }
                        cfg := defaultConfig() // 损坏回退默认值（与 loadLocked 一致）
                        _ = json.Unmarshal(raw, &cfg)
                        c.mu.Lock()
                        c.cfg = cfg // 以磁盘为准
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
