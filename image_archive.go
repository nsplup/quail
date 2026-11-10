package main

// ImageArchive：命令面板「归档图片文件到伴生资源目录」的后端支撑
// （FileService 绑定方法 ArchiveImages）。
//
// 流程：前端把编辑器持有的当前内容整体传入 → 本方法解析三种图片引用
// （内联式 ![alt](url)、引用式 ![alt][id] + [id]: url、HTML <img src>），
// 本地图片复制、远程图片下载到【目标路径】的伴生资源目录（markdown
// 文档：<targetDir>/<BASE>.md.assets/，非 markdown 回落 <targetDir>/assets/
// ——与 image_import.go / imgproxy.go 白名单同口径），然后把内容中的
// 引用路径统一替换为相对目标文档目录的新路径，落盘文档后返回结果。
// 前端文档会话状态不变（监听不迁移、状态不更新）。
//
// 【写入不携带自身写入抑制】本方法写盘不经 guard.begin 登记、不更新
// lastKnown（区别于 Save / writeThrough / atomicWrite）：当目标路径就是
// 当前文档时，watch 防抖读盘核对哈希必然未命中登记令牌 → 放行广播
// file:changed，前端由此得知文档被修改（既有「重新加载 / 忽略」横幅
// 流程接管）；若抑制了自身写入，后续保存覆盖当前文档时前端将无从
// 感知磁盘内容已变化。
//
// 引用识别口径：
//   - http(s) 远程与非 data: 的本地路径参与归档；data: URI、空链接、
//     解析失败的 dest 保持原样不动；
//   - 引用式定义仅归档被 ![alt][id]（含 ![alt][] 速记）实际引用的定义，
//     避免把普通链接定义误当图片下载；
//   - 标识符匹配按 micromark normalizeIdentifier 口径折叠（trim、空白
//     折叠为单空格、小写），与前端 normalizeImageRefId 一致；
//   - 本地路径先做百分号解码（前端插入时对空格/括号等编码）再按
//     当前文档目录解析相对路径（内容来自编辑器缓冲区，相对引用的
//     基准是当前文档所在目录而非目标路径目录）；远程 URL 原样解析；
//     HTML src 另做最小 HTML 实体解码（&amp; 等）；
//   - 落盘命名沿用 saveImageBytes：有文件名沿用原名（换真实扩展名，
//     冲突 -n 后缀），无文件名 img-<内容短哈希>（存在即复用）；统一
//     魔数校验（仅放行真实图片，SVG 拒绝，与三入口口径一致）；
//   - 同一图片（同解析结果）多引用只落盘一份；已位于目标伴生资源
//     目录内的本地图片不重复复制，直接换算引用路径。
//
// 替换规则：内联式与引用定义的 destination 含空白/括号/尖括号时用
// <...> 包裹并做最小转义（与前端 escapeAngleDest 同口径），否则保持
// 裸路径；HTML src 直接写带引号属性值；alt 与标题原样保留。
//
// 已知局限：引用识别为正则口径（非 markdown AST），围栏代码块内的
// 示例语法同样参与识别与替换；与「引用样式宽松子集」的取舍记录于此。

import (
        "errors"
        "net/url"
        "os"
        "path/filepath"
        "regexp"
        "strings"
)

// ArchiveResult 图片归档结果（返回给前端）。
type ArchiveResult struct {
        Ok   bool   `json:"ok"`
        Path string `json:"path"`
        // Found 发现的可归档图片引用数（按解析结果去重）。
        Found int `json:"found"`
        // Archived 成功复制/下载到伴生资源目录的数量。
        Archived int `json:"archived"`
        // Failed 读取/下载/校验失败的数量（对应引用保持原样不动）。
        Failed int `json:"failed"`
        // Written 是否已将替换后的内容落盘（无引用/全部失败/内容无变化时不写）。
        Written bool `json:"written"`
}

var (
        // 内联式 ![alt](dest "title")：dest 支持尖括号包裹与裸路径两种形态
        inlineImageRe = regexp.MustCompile(`!\[([^\]\n]*)\]\(\s*(?:<([^>]*)>|([^)\s]+))(\s+"[^"\n]*")?\s*\)`)
        // 引用式定义 [id]: dest "title"（行级常用子集；indent 保留）
        refDefRe = regexp.MustCompile(`(?m)^([ \t]*)\[([^\]\n]+)\]:[ \t]*(?:<([^>]*)>|([^ \t\n]+))([ \t]+"[^"\n]*")?[ \t]*$`)
        // 引用式图片 ![alt][id] / ![alt][]（速记：label 取 alt）
        refImageRe = regexp.MustCompile(`!\[([^\]\n]*)\]\[([^\]\n]*)\]`)
        // HTML <img src="..."> / <img src='...'>：group1 = src= 前缀（含 img 开头），
        // group2 = 带引号属性值
        htmlImgRe = regexp.MustCompile(`(?i)(<img\b[^>]*?\bsrc[ \t]*=[ \t]*)("[^"]*"|'[^']*')`)
)

// archiveRef 单个待归档图片引用的解析结果。
type archiveRef struct {
        raw      string  // 原样 dest（内容中替换查表键）
        remote   bool    // true = 远程下载；false = 本地复制
        url      *url.URL
        localAbs string // 本地绝对路径（clean 后）
        baseName string // 建议落盘文件名（空 = 内容短哈希命名）
}

// htmlEntityRepl HTML 属性值最小实体解码（raw HTML 中的 src 常见转义）。
var htmlEntityRepl = strings.NewReplacer(
        "&amp;", "&", "&lt;", "<", "&gt;", ">", "&quot;", "\"", "&#39;", "'", "&apos;", "'",
)

// ArchiveImages 归档内容中的图片引用到目标路径的伴生资源目录。
// content 由前端整体传入（编辑器缓冲区）；targetPath 为保存对话框
// 选定的输出路径。写入不带自身写入抑制（见文件头注释）。
func (f *FileService) ArchiveImages(content string, targetPath string) (*ArchiveResult, error) {
        if strings.TrimSpace(targetPath) == "" {
                return nil, errors.New("target path is empty")
        }
        abs, err := filepath.Abs(targetPath)
        if err != nil {
                return nil, err
        }

        // 当前文档上下文：相对本地引用的解析基准（内容来自编辑器缓冲区，
        // 相对引用基准 = 当前文档所在目录）；目标为当前文档时沿用其原
        // 编码/BOM 写回，其余目标路径一律 UTF-8 无 BOM。会话状态一律不动。
        f.mu.Lock()
        sourceDir := ""
        enc, bom := "utf-8", false
        if f.doc != nil && f.doc.path != "" {
                sourceDir = filepath.Dir(f.doc.path)
                if f.doc.path == abs { // 覆盖当前文档：按原编码写回（与 Save 同口径）
                        enc, bom = f.doc.encoding, f.doc.bom
                }
        }
        f.mu.Unlock()

        assetsDir, err := assetsDirForPath(abs)
        if err != nil {
                return nil, err
        }

        // 1) 收集引用：key = 原样 dest；canonical = 解析结果（同图去重）
        usedIDs := collectUsedRefIDs(content)
        keyToCanon := map[string]string{}
        jobs := map[string]*archiveRef{}
        found := 0

        addRef := func(raw string, html bool) {
                key := strings.TrimSpace(raw)
                if key == "" {
                        return
                }
                if _, seen := keyToCanon[key]; seen {
                        return
                }
                ref := resolveArchiveRef(key, sourceDir, html)
                if ref == nil {
                        return // data: / 无法解析：不参与归档，引用保持原样
                }
                keyToCanon[key] = ref.canonical()
                jobs[ref.canonical()] = ref
                found++
        }

        for _, g := range inlineImageRe.FindAllStringSubmatch(content, -1) {
                dest := g[2]
                if dest == "" {
                        dest = g[3]
                }
                addRef(dest, false)
        }
        for _, g := range refDefRe.FindAllStringSubmatch(content, -1) {
                if !usedIDs[normalizeRefID(g[2])] {
                        continue // 未被图片引用的定义（可能是链接）：跳过
                }
                dest := g[3]
                if dest == "" {
                        dest = g[4]
                }
                addRef(dest, false)
        }
        for _, g := range htmlImgRe.FindAllStringSubmatch(content, -1) {
                addRef(g[2][1:len(g[2])-1], true) // 去引号
        }

        // 2) 归档：本地复制 / 远程下载（saveImageBytes 统一魔数校验与命名）
        archived, failed := 0, 0
        relByCanon := map[string]string{}
        for canon, job := range jobs {
                if !job.remote {
                        // 已位于目标伴生资源目录内（典型：目标即当前文档）：不复制，
                        // 直接换算引用路径
                        if rel, rerr := filepath.Rel(assetsDir, job.localAbs); rerr == nil &&
                                rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
                                relByCanon[canon] = filepath.ToSlash(rel)
                                archived++
                                continue
                        }
                }
                var data []byte
                var err error
                if job.remote {
                        data, err = fetchRemoteImage(job.url)
                } else {
                        data, err = os.ReadFile(job.localAbs)
                }
                if err != nil {
                        failed++
                        continue
                }
                img, ok := saveImageBytes(assetsDir, data, job.baseName)
                if !ok {
                        failed++ // 非真实图片（SVG/魔数未命中）：引用保持原样
                        continue
                }
                relByCanon[canon] = img.RelPath
                archived++
        }

        // 3) 替换引用路径（仅当有成功归档时才动内容）
        newContent := content
        if archived > 0 {
                relByKey := func(key string) (string, bool) {
                        canon, ok := keyToCanon[key]
                        if !ok {
                                return "", false
                        }
                        rel, ok := relByCanon[canon]
                        return rel, ok
                }
                newContent = inlineImageRe.ReplaceAllStringFunc(newContent, func(m string) string {
                        g := inlineImageRe.FindStringSubmatch(m)
                        if g == nil {
                                return m
                        }
                        dest := g[2]
                        if dest == "" {
                                dest = g[3]
                        }
                        rel, ok := relByKey(dest)
                        if !ok {
                                return m
                        }
                        return "![" + g[1] + "](" + markdownDest(rel) + g[4] + ")"
                })
                newContent = replaceRefDefs(newContent, usedIDs, relByKey)
                newContent = replaceHtmlImgs(newContent, relByKey)
        }

        // 4) 落盘（仅内容变化时）。【不携带自身写入抑制】：不登记写入令牌、
        // 不更新 lastKnown —— 目标为当前文档时 watch 读盘核对未命中 → 放行
        // 广播 file:changed，前端由此得知文档被修改。
        changed := archived > 0 && newContent != content
        if changed {
                raw, err := encodeForWrite(newContent, enc, bom)
                if err != nil {
                        return nil, err
                }
                mode := os.FileMode(0o644)
                if info, serr := os.Stat(abs); serr == nil {
                        mode = info.Mode().Perm() // 保留原文件权限（与 atomicWrite 同口径）
                }
                if err := writeFileAtomic(abs, raw, mode); err != nil {
                        return nil, err
                }
        }

        return &ArchiveResult{
                Ok:       true,
                Path:     abs,
                Found:    found,
                Archived: archived,
                Failed:   failed,
                Written:  changed,
        }, nil
}

/* ---------------- 引用收集与解析 ---------------- */

// collectUsedRefIDs 收集被引用式图片实际使用的定义标识符（normalize 后）。
func collectUsedRefIDs(content string) map[string]bool {
        used := map[string]bool{}
        for _, g := range refImageRe.FindAllStringSubmatch(content, -1) {
                id := g[2]
                if id == "" {
                        id = g[1] // 速记 ![alt][]：label 取 alt
                }
                if id == "" {
                        continue
                }
                used[normalizeRefID(id)] = true
        }
        return used
}

// normalizeRefID micromark normalizeIdentifier 口径：trim、空白折叠为
// 单空格、小写（与前端 normalizeImageRefId 一致）。
func normalizeRefID(s string) string {
        return strings.ToLower(strings.Join(strings.Fields(s), " "))
}

// resolveArchiveRef dest 分类：http(s) 远程 / 本地路径；不可归档返回 nil。
func resolveArchiveRef(key string, sourceDir string, html bool) *archiveRef {
        s := key
        if html {
                s = htmlEntityRepl.Replace(s)
        }
        if s == "" || strings.HasPrefix(s, "data:") {
                return nil
        }
        if strings.HasPrefix(s, "http://") || strings.HasPrefix(s, "https://") {
                u, err := url.Parse(s)
                if err != nil || u.Host == "" {
                        return nil
                }
                return &archiveRef{raw: key, remote: true, url: u, baseName: sanitizeRemoteName(remoteImageBaseName(u))}
        }
        // 本地：file:// 前缀剥离 + 百分号解码（前端插入时编码空格/括号等）
        p := strings.TrimPrefix(s, "file://")
        if dec, derr := url.PathUnescape(p); derr == nil {
                p = dec
        }
        if !filepath.IsAbs(p) {
                if sourceDir == "" {
                        return nil // 未命名文档：相对路径无从解析
                }
                p = filepath.Join(sourceDir, p)
        }
        return &archiveRef{raw: key, localAbs: filepath.Clean(p), baseName: filepath.Base(p)}
}

// canonical 解析结果去重键：远程 = 规范化 URL；本地 = 绝对路径。
func (r *archiveRef) canonical() string {
        if r.remote {
                return r.url.String()
        }
        return r.localAbs
}

// remoteImageBaseName 从远程 URL 路径取文件名（取不到返回空 → 哈希命名）。
func remoteImageBaseName(u *url.URL) string {
        name := u.Path
        if i := strings.LastIndex(name, "/"); i >= 0 {
                name = name[i+1:]
        }
        if dec, err := url.PathUnescape(name); err == nil {
                name = dec
        }
        if name == "" || name == "." || name == ".." {
                return ""
        }
        return name
}

// sanitizeRemoteName 远程文件名清洗：Windows 保留字符与路径分隔符 → '_'。
// 本地文件名天然合法，无需清洗；远程 URL 文件名可能含 ? * : 等解码产物。
func sanitizeRemoteName(name string) string {
        return strings.Map(func(r rune) rune {
                switch r {
                case '/', '\\', ':', '*', '?', '"', '<', '>', '|':
                        return '_'
                }
                if r < 0x20 {
                        return '_'
                }
                return r
        }, name)
}

/* ---------------- 替换 ---------------- */

// markdownDest 替换后引用路径的 markdown destination 形态：含空白/括号/
// 尖括号时用 <...> 包裹并做最小转义（\、<、>，与前端 escapeAngleDest 同
// 口径），否则保持裸路径。
func markdownDest(rel string) string {
        if strings.ContainsAny(rel, " \t\n()<>") {
                escaped := strings.NewReplacer("\\", "\\\\", "<", "\\<", ">", "\\>").Replace(rel)
                return "<" + escaped + ">"
        }
        return rel
}

// replaceRefDefs 替换被图片引用的定义行 URL（alt/indent/title 原样保留，
// 分隔符归一为单空格）。
func replaceRefDefs(content string, usedIDs map[string]bool, relByKey func(string) (string, bool)) string {
        return refDefRe.ReplaceAllStringFunc(content, func(m string) string {
                g := refDefRe.FindStringSubmatch(m)
                if g == nil {
                        return m
                }
                if !usedIDs[normalizeRefID(g[2])] {
                        return m
                }
                dest := g[3]
                if dest == "" {
                        dest = g[4]
                }
                rel, ok := relByKey(dest)
                if !ok {
                        return m
                }
                return g[1] + "[" + g[2] + "]: " + markdownDest(rel) + g[5]
        })
}

// replaceHtmlImgs 替换 <img src> 属性值（带引号原样重建，HTML 无需包裹）。
func replaceHtmlImgs(content string, relByKey func(string) (string, bool)) string {
        return htmlImgRe.ReplaceAllStringFunc(content, func(m string) string {
                g := htmlImgRe.FindStringSubmatch(m)
                if g == nil {
                        return m
                }
                rel, ok := relByKey(g[2][1 : len(g[2])-1]) // 去引号
                if !ok {
                        return m
                }
                return g[1] + "\"" + rel + "\""
        })
}

/* ---------------- 资源目录 ---------------- */

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
