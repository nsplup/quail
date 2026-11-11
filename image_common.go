package main

// ImageCommon：三个图片模块（插入 image_import.go / 归档 image_archive.go /
// 右键动作 image_actions.go）与 imgproxy.go 共用的基础件（消除跨模块重复实现）。
//
// 路径生成统一口径（本文件为唯一出口）：
//   - markdownDest：RelPath → markdown 内联 destination。不做尖括号包裹、
//     不做反斜杠转义：不安全字符（空白 / 控制字符 / <>()[]{}"`#%?*:|\ 等）
//     直接替换为 '-'。插入通道（saveImageBytes）落盘命名已先经
//     sanitizeDestSegment 替换为安全字符，生成的引用路径天然无需再转义；
//     归档通道复用既有文件时仅接受已安全的文件名（不安全则改为复制换名），
//     本函数的替换仅作极端兜底。
//   - sanitizeDestSegment：文件名（单段）级 sanitize，'/' 一并替换——归档
//     远程基名与插入入口的原始文件名统一走此函数（原 sanitizeRemoteName /
//     前端 escapeAltText+escapeAngleDest 的后端继任者）。
//   - sanitizeAltText：alt 文本 sanitize，[ ] \ 与换行替换为安全字符
//     （不再用反斜杠转义）。
//
// 共享目录 / 读取 / 解析：
//   - assetsDirForPath：文档路径 → 伴生资源目录（MkdirAll），插入与归档共用；
//   - pathRelativeToDoc：资产文件 → 相对文档目录的正斜杠引用路径；
//   - readFileHead：文件头 4KB 读取（魔数嗅探用）；
//   - parseRemoteImageURL：远程图片 URL 校验（http/https + Host），
//     imgproxy serveRemote / ImageFilePath resolveRemoteTarget /
//     归档 resolveArchiveRef 三处共用；
//   - resolveLocalDocAsset：imgproxy serveLocal 与 ImageFilePath/ImageSaveFile
//     的本地目标解析共用（白名单 isAllowedLocalTarget + 软链接逃逸兜底 +
//     存在性校验），口径完全一致。

import (
        "errors"
        "io"
        "net/url"
        "os"
        "path/filepath"
        "runtime"
        "strings"
)

/* ---------------- 资源目录与相对路径 ---------------- */

// assetsDirForPath 任意文档路径对应的图片落盘目录：markdown 文档用
// 伴生资源目录候选首项（<BASE>.md.assets），非 markdown 回落 assets/
// （imgproxy 白名单固定放行的资产子目录）。目录不存在时创建。
func assetsDirForPath(path string) (string, error) {
        dir := filepath.Dir(path)
        sub := "assets"
        if names := companionAssetsNames(filepath.Base(path)); len(names) > 0 {
                sub = names[0]
        }
        assetsDir := filepath.Join(dir, sub)
        if err := os.MkdirAll(assetsDir, 0o755); err != nil {
                return "", err
        }
        return assetsDir, nil
}

// pathRelativeToDoc 资产文件相对文档目录的引用路径（正斜杠）。
// assetsDir 由 assetsDirForPath 在文档目录下创建，Rel 必然不含 ".."。
func pathRelativeToDoc(assetsDir, name string) string {
        rel, err := filepath.Rel(filepath.Dir(assetsDir), filepath.Join(assetsDir, name))
        if err != nil {
                return name
        }
        return filepath.ToSlash(rel)
}

// readFileHead 读取文件前 4KB（魔数嗅探用；不足 4KB 返回实际长度）。
func readFileHead(path string) ([]byte, error) {
        fh, err := os.Open(path)
        if err != nil {
                return nil, err
        }
        defer fh.Close()
        head := make([]byte, 4096)
        n, err := io.ReadFull(fh, head)
        if err != nil && err != io.ErrUnexpectedEOF && err != io.EOF {
                return nil, err
        }
        return head[:n], nil
}

/* ---------------- 路径与文本 sanitize ---------------- */

// unsafeDestRune 判定是否 markdown destination / 文件名中的不安全字符：
//   - 控制字符与空白（裸 destination 不得含空白）；
//   - Windows 文件名非法字符（<>:"/\|?*）与跨平台隐患（\）；
//   - markdown / URL 语义字符（()[]{}" ` # % ? * : |）——插入通道的
//     destination 不做尖括号包裹与转义，这些字符一律在源头替换掉。
func unsafeDestRune(r rune) bool {
        if r < 0x20 || r == 0x7f {
                return true
        }
        switch r {
        case ' ', '\t', '\n', '\r', '\v', '\f':
                return true
        case '<', '>', '(', ')', '[', ']', '{', '}', '"', '`', '#', '%', '?', '*', ':', '|', '\\', '/':
                return true
        }
        return false
}

// sanitizeDestSegment 单段文件名级 sanitize：不安全字符（含 '/'，单段
// 场景不存在合法的分隔符）替换为 '-'。归档远程基名与插入入口的原始
// 文件名统一走此函数；扩展名由落盘时的魔数校验决定，不依赖原名。
func sanitizeDestSegment(name string) string {
        return strings.Map(func(r rune) rune {
                if unsafeDestRune(r) {
                        return '-'
                }
                return r
        }, name)
}

// markdownDest RelPath → markdown destination（路径生成单点出口）。
// '/' 为路径分隔符保留，其余不安全字符替换为 '-'：无尖括号包裹、
// 无反斜杠转义。插入通道落盘命名已经 sanitizeDestSegment 保证安全，
// 本函数对安全路径恒等（归档复用既有文件时以此判定"已安全"）。
func markdownDest(rel string) string {
        return strings.Map(func(r rune) rune {
                if r != '/' && unsafeDestRune(r) {
                        return '-'
                }
                return r
        }, rel)
}

// sanitizeAltText alt 文本 sanitize：[ ] \ 破坏内联语法（![alt](dest) 的
// alt 以 ] 结束、\ 是转义前缀），换行破坏行结构——统一替换为安全字符，
// 不再用反斜杠转义（原前端 escapeAltText 的后端继任者）。
func sanitizeAltText(alt string) string {
        return strings.Map(func(r rune) rune {
                switch r {
                case '[', ']', '\\':
                        return '-'
                case '\n', '\r':
                        return ' '
                }
                return r
        }, alt)
}

/* ---------------- 远程 URL 与本地目标解析 ---------------- */

// parseRemoteImageURL 远程图片 URL 校验：http/https + Host 非空。
// imgproxy serveRemote、ImageFilePath resolveRemoteTarget 与归档
// resolveArchiveRef 共用（消除三处各自为政的前缀判断）。
func parseRemoteImageURL(s string) (*url.URL, bool) {
        u, err := url.Parse(strings.TrimSpace(s))
        if err != nil || u == nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
                return nil, false
        }
        return u, true
}

// 本地解析哨兵错误（serveLocal 据此映射 HTTP 状态码，语义与原实现一致）。
var (
        errProxyNoDoc      = errors.New("document not saved")
        errProxyMissingP   = errors.New("missing p")
        errProxyRestricted = errors.New("access restricted")
        errProxyNotFound   = errors.New("file not found")
)

// resolveLocalDocAsset imgproxy serveLocal 与 image_actions 的本地目标解析
// 共用：raw p → 磁盘绝对路径。校验链：当前文档白名单
//（isAllowedLocalTarget：[FILE_DIR]/*、assets/**、[FILE_NAME].assets/**，
// 语义化包含判定防 ../ 逃逸）+ 软链接逃逸兜底 + 存在性校验。
// 内容魔数校验由调用方按通道执行（serveLocal 整读校验，
// ImageFilePath 头嗅探），不在此重复。
func resolveLocalDocAsset(f *FileService, raw string) (string, error) {
        docPath := f.CurrentPath()
        if docPath == "" {
                return "", errProxyNoDoc
        }
        docDir := filepath.Dir(docPath)
        docName := filepath.Base(docPath)

        raw = strings.TrimSpace(raw)
        if raw == "" {
                return "", errProxyMissingP
        }
        var target string
        if filepath.IsAbs(raw) {
                target = filepath.Clean(raw)
        } else {
                target = filepath.Clean(filepath.Join(docDir, raw))
        }

        if !isAllowedLocalTarget(runtime.GOOS, docDir, docName, target) {
                return "", errProxyRestricted
        }
        // 软链接逃逸兜底：真实路径解析后仍须在白名单内
        if resolved, err := filepath.EvalSymlinks(target); err == nil && resolved != target {
                if !isAllowedLocalTarget(runtime.GOOS, docDir, docName, resolved) {
                        return "", errProxyRestricted
                }
        }
        if _, err := os.Stat(target); err != nil {
                if os.IsNotExist(err) {
                        return "", errProxyNotFound
                }
                return "", err
        }
        return target, nil
}
