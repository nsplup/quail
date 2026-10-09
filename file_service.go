package main

// FileService：文档打开 / 保存 / 另存 / 目录监听。
//
// - Open 读取文件（编码统一转 UTF-8），持有文档状态（路径、mtime、sha256）
//   并启动 fsnotify 目录监听，过滤出当前文档的变动事件（300ms 防抖合并）；
// - Save 原子写（同目录临时文件 + rename + 保留权限），写入前用 sha256 对比
//   检测外部修改冲突，冲突返回 SaveResult{Conflict:true}，不覆盖磁盘；
// - SaveAs 原子写新路径并把监听迁移过去；
// - watch 为私有方法，不会被 bindings 暴露给前端。

import (
        "context"
        "crypto/sha256"
        "encoding/hex"
        "errors"
        "fmt"
        "os"
        "path/filepath"
        "sync"
        "time"

        "github.com/fsnotify/fsnotify"
        "github.com/wailsapp/wails/v3/pkg/application"
)

// DocState 打开的文档状态（返回给前端）。
type DocState struct {
        Path     string `json:"path"`
        Dir      string `json:"dir"`
        Name     string `json:"name"`
        Content  string `json:"content"` // 统一 UTF-8
        Encoding string `json:"encoding"` // 磁盘原编码（保存写回用）
        Size     int64  `json:"size"`
        ModTime  int64  `json:"modTime"` // unix 毫秒
}

// SaveResult 保存结果。
type SaveResult struct {
        Ok       bool   `json:"ok"`
        Conflict bool   `json:"conflict"` // 磁盘内容已被外部修改
        Path     string `json:"path"`
        // ExternalModTime 冲突时磁盘文件当前的修改时间（unix 毫秒）
        ExternalModTime int64 `json:"externalModTime,omitempty"`
}

// docStatus 内部持有态（Content 不进内存副本，仅路径与指纹）。
type docStatus struct {
        path       string
        encoding   string
        lastKnown  string // 最后一次与磁盘核对一致的 sha256（hex）
        suppress   bool   // 自身写入抑制标记（Save → watch 回环）
}

// FileService 三个导出服务之一。
type FileService struct {
        mu      sync.Mutex
        doc     *docStatus
        watcher *fsnotify.Watcher
        quit    chan struct{}
}

// NewFileService 构造。
func NewFileService() *FileService {
        return &FileService{}
}

// ServiceStartup 生命周期钩子。
func (f *FileService) ServiceStartup(context.Context, application.ServiceOptions) error {
        return nil
}

// ServiceShutdown 停止监听。
func (f *FileService) ServiceShutdown() {
        f.stopWatch()
}

// CurrentPath 当前打开文档路径；未打开返回空串。
func (f *FileService) CurrentPath() string {
        f.mu.Lock()
        defer f.mu.Unlock()
        if f.doc == nil {
                return ""
        }
        return f.doc.path
}

// Open 打开文档：读取、转码 UTF-8、持有状态、启动监听。
func (f *FileService) Open(path string) (*DocState, error) {
        abs, err := filepath.Abs(path)
        if err != nil {
                return nil, err
        }
        raw, err := os.ReadFile(abs)
        if err != nil {
                return nil, err
        }
        content, enc, err := decodeToUTF8(raw)
        if err != nil {
                return nil, err
        }
        info, err := os.Stat(abs)
        if err != nil {
                return nil, err
        }

        f.mu.Lock()
        defer f.mu.Unlock()
        f.stopWatchLocked()
        f.doc = &docStatus{
                path:      abs,
                encoding:  enc,
                lastKnown: sha256Hex(raw),
        }
        _ = f.startWatchLocked(filepath.Dir(abs), filepath.Base(abs)) // 监听失败不阻塞打开，仅降级
        // 记入最近文件
        configSvc.AddRecentFile(abs)

        st := &DocState{
                Path:     abs,
                Dir:      filepath.Dir(abs),
                Name:     filepath.Base(abs),
                Content:  content,
                Encoding: enc,
                Size:     info.Size(),
                ModTime:  info.ModTime().UnixMilli(),
        }
        return st, nil
}

// Save 原子保存当前文档（UTF-8 进，按原编码写回磁盘）。
// 磁盘 sha 与持有 sha 不一致 → Conflict（附外部文件信息），不覆盖；
// force=true 表示用户已在前端确认"以我的版本覆盖"，跳过冲突检查。
// 注意 file:changed 到达后 lastKnown 已同步为磁盘内容，残余的磁盘漂移只能
// 来自监听抑制窗口/监听降级场景——冲突检查是最后一道防线，不能省。
// 写入前设置抑制标记，避免自身 rename 触发 file:changed 回环。
func (f *FileService) Save(content string, force bool) (*SaveResult, error) {
        f.mu.Lock()
        defer f.mu.Unlock()
        if f.doc == nil {
                return nil, errors.New("没有打开的文档")
        }
        f.doc.suppress = true // 抑制自身 rename 触发的 file:changed 回环
        defer clearSuppressLater(f)
        if force {
                return f.writeThrough(content)
        }
        return f.atomicWrite(f.doc.path, content, f.doc.encoding)
}

// writeThrough 跳过冲突检测直接写盘（用户已在前端确认覆盖）。
func (f *FileService) writeThrough(content string) (*SaveResult, error) {
        raw, err := encodeFromUTF8(content, f.doc.encoding)
        if err != nil {
                return nil, fmt.Errorf("保存失败: %w", err)
        }
        mode := os.FileMode(0o644)
        if info, err := os.Stat(f.doc.path); err == nil {
                mode = info.Mode().Perm()
        }
        if err := writeFileAtomic(f.doc.path, raw, mode); err != nil {
                return nil, err
        }
        f.doc.lastKnown = sha256Hex(raw)
        return &SaveResult{Ok: true, Path: f.doc.path}, nil
}

// SaveAs 另存为新路径，并迁移监听与持有状态。
func (f *FileService) SaveAs(path, content string) (*SaveResult, error) {
        abs, err := filepath.Abs(path)
        if err != nil {
                return nil, err
        }
        // 另存不受外部冲突检测约束（新位置没有"上次已知"）
        // 另存统一以 UTF-8 落盘（新位置无历史编码包袱）。
        if err := writeFileAtomic(abs, []byte(content), 0o644); err != nil {
                return nil, err
        }
        f.mu.Lock()
        defer f.mu.Unlock()
        f.stopWatchLocked()
        f.doc = &docStatus{path: abs, encoding: "utf-8", lastKnown: sha256Hex([]byte(content))}
        f.doc.suppress = true // 另存的 rename 同样会触发事件，需抑制
        _ = f.startWatchLocked(filepath.Dir(abs), filepath.Base(abs)) // 监听失败降级
        defer clearSuppressLater(f)
        configSvc.AddRecentFile(abs)
        return &SaveResult{Ok: true, Path: abs}, nil
}

// clearSuppressLater 延迟清除抑制标记：覆盖 rename → fsnotify 事件 →
// 300ms 防抖的完整窗口。持锁状态下调用，协程内自行取锁。
func clearSuppressLater(f *FileService) {
        time.AfterFunc(600*time.Millisecond, func() {
                f.mu.Lock()
                if f.doc != nil {
                        f.doc.suppress = false
                }
                f.mu.Unlock()
        })
}

// PickOpen 弹出系统"打开文件"对话框，返回所选路径（取消返回空串）。
func (f *FileService) PickOpen() (string, error) {
	app := application.Get()
	if app == nil {
		return "", nil
	}
	return app.Dialog.OpenFile().
		SetTitle("打开 Markdown 文档").
		AddFilter("Markdown", "*.md;*.markdown").
		AddFilter("Text", "*.txt").
		AddFilter("All Files", "*.*").
		PromptForSingleSelection()
}

// PickSave 弹出系统"保存文件"对话框，返回目标路径（取消返回空串）。
func (f *FileService) PickSave(defaultName string) (string, error) {
	app := application.Get()
	if app == nil {
		return "", nil
	}
	if defaultName == "" {
		defaultName = "untitled.md"
	}
	return app.Dialog.SaveFile().
		SetTitle("另存为").
		SetFilename(defaultName).
		AddFilter("Markdown", "*.md;*.markdown").
		PromptForSingleSelection()
}

// CloseDoc 关闭当前文档（停止监听、清空持有态）。
func (f *FileService) CloseDoc() {
        f.mu.Lock()
        defer f.mu.Unlock()
        f.stopWatchLocked()
        f.doc = nil
}

/* ---------------- 内部：watch 与原子写 ---------------- */

// startWatchLocked 监听目录，过滤文件名；必须持 f.mu。
func (f *FileService) startWatchLocked(dir, base string) error {
        w, err := fsnotify.NewWatcher()
        if err != nil {
                return err
        }
        if err := w.Add(dir); err != nil {
                w.Close()
                return err
        }
        f.watcher = w
        f.quit = make(chan struct{})

        go func() {
                // 防抖：fsnotify 常在一次写盘里连发多个事件，300ms 窗口合并
                var (
                        fireTimer *time.Timer
                        deleted   bool
                )
                fire := func() {
                        f.mu.Lock()
                        doc := f.doc
                        sup := doc != nil && doc.suppress
                        path := ""
                        if doc != nil {
                                path = doc.path
                        }
                        f.mu.Unlock()
                        if doc == nil || sup {
                                return // 已关闭或自身写入回环
                        }
                        if deleted {
                                doc.lastKnown = "" // 文件没了，清指纹
                                emit(EventFileDeleted, FileEventData{Path: path})
                                return
                        }
                        raw, err := os.ReadFile(path)
                        if err != nil {
                                emit(EventFileDeleted, FileEventData{Path: path})
                                return
                        }
                        content, _, err := decodeToUTF8(raw)
                        if err != nil {
                                return
                        }
                        f.mu.Lock()
                        doc.lastKnown = sha256Hex(raw) // 外部内容成为新基线
                        f.mu.Unlock()
                        emit(EventFileChanged, FileEventData{Path: path, Content: content})
                }
                for {
                        select {
                        case <-f.quit:
                                return
                        case ev, ok := <-w.Events:
                                if !ok {
                                        return
                                }
                                if filepath.Base(ev.Name) != base {
                                        continue // 只关心当前文档
                                }
                                if ev.Has(fsnotify.Remove) || ev.Has(fsnotify.Rename) {
                                        deleted = true
                                        if fireTimer != nil {
                                                fireTimer.Stop()
                                        }
                                        fireTimer = time.AfterFunc(200*time.Millisecond, fire)
                                        continue
                                }
                                deleted = false
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

// stopWatch 停止监听（外部持锁版本见 stopWatchLocked）。
func (f *FileService) stopWatch() {
        f.mu.Lock()
        defer f.mu.Unlock()
        f.stopWatchLocked()
}

// stopWatchLocked 必须持 f.mu。
func (f *FileService) stopWatchLocked() {
        if f.quit != nil {
                close(f.quit)
                f.quit = nil
        }
        if f.watcher != nil {
                f.watcher.Close()
                f.watcher = nil
        }
}

// atomicWrite 带冲突检测的原子写：sha 对比 → temp+rename。
func (f *FileService) atomicWrite(path, content, enc string) (*SaveResult, error) {
        raw, err := encodeFromUTF8(content, enc)
        if err != nil {
                return nil, fmt.Errorf("编码转换失败: %w", err)
        }
        // 冲突检测：磁盘当前字节（可能被外部改过）与最后已知指纹比对
        disk, err := os.ReadFile(path)
        if err == nil && f.doc.lastKnown != "" && sha256Hex(disk) != f.doc.lastKnown {
                mt := int64(0)
                if info, serr := os.Stat(path); serr == nil {
                        mt = info.ModTime().UnixMilli()
                }
                return &SaveResult{Ok: false, Conflict: true, Path: path, ExternalModTime: mt}, nil
        }
        mode := os.FileMode(0o644)
        if info, serr := os.Stat(path); serr == nil {
                mode = info.Mode().Perm() // 保留原文件权限
        }
        if err := writeFileAtomic(path, raw, mode); err != nil {
                return nil, err
        }
        f.doc.lastKnown = sha256Hex(raw) // 新基线 = 磁盘实际字节
        return &SaveResult{Ok: true, Path: path}, nil
}

// writeFileAtomic 同目录临时文件 + rename，保证原子性与同文件系统 rename。
func writeFileAtomic(path string, data []byte, mode os.FileMode) error {
        dir := filepath.Dir(path)
        tmp, err := os.CreateTemp(dir, ".quail-tmp-*")
        if err != nil {
                return err
        }
        tmpName := tmp.Name()
        cleanup := func() {
                tmp.Close()
                os.Remove(tmpName)
        }
        if _, err := tmp.Write(data); err != nil {
                cleanup()
                return err
        }
        if err := tmp.Sync(); err != nil {
                cleanup()
                return err
        }
        if err := tmp.Close(); err != nil {
                os.Remove(tmpName)
                return err
        }
        if err := os.Chmod(tmpName, mode); err != nil {
                os.Remove(tmpName)
                return err
        }
        return os.Rename(tmpName, path)
}

func sha256Hex(b []byte) string {
        sum := sha256.Sum256(b)
        return hex.EncodeToString(sum[:])
}
