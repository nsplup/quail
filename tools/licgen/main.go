// Package main —— licgen：构建期后端依赖许可信息收集器。
//
// 用法（在 frontend 目录下，见 build/Taskfile.yml build:frontend）：
//
//      go run ../tools/licgen -out src/lib/generated/backend-deps.json
//
// 以 `go list -m -json all` 枚举全部 Go 模块（含间接依赖与 wails 框架本体），
// 从模块缓存（$GOMODCACHE/<mod>@<ver>）中查找 LICENSE / COPYING / NOTICE 类
// 文件，自动提取许可证标识与版权声明，输出按名称排序的 JSON 数组，供前端
// 「开源许可」页面直接 import（与 generate-build-info.mjs 的前端依赖清单同构）。
//
// 仅使用标准库，不引入新的 go.mod 依赖。
package main

import (
        "encoding/json"
        "flag"
        "fmt"
        "os"
        "os/exec"
        "path/filepath"
        "regexp"
        "sort"
        "strings"
)

// dep 输出条目（与 frontend-deps.json 同构，见 frontend/src/lib/licenses.ts）。
type dep struct {
        Name      string `json:"name"`
        Version   string `json:"version"`
        License   string `json:"license"`
        Copyright string `json:"copyright"`
        URL       string `json:"url"`
}

// module 是 `go list -m -json` 输出中用到的字段子集。
type module struct {
        Path    string
        Version string
        Dir     string
        Main    bool
}

var licFileRe = regexp.MustCompile(`^(licen[cs]e|copying|copyright|notice|unlicense)(\..*)?$`)

func main() {
        out := flag.String("out", "frontend/src/lib/generated/backend-deps.json", "输出 JSON 路径")
        flag.Parse()

        cmd := exec.Command("go", "list", "-m", "-json", "all")
        cmd.Stderr = os.Stderr
        data, err := cmd.Output()
        if err != nil {
                fmt.Fprintln(os.Stderr, "licgen: go list:", err)
                os.Exit(1)
        }

        dec := json.NewDecoder(strings.NewReader(string(data)))
        deps := []dep{}
        for {
                var m module
                if err := dec.Decode(&m); err != nil {
                        break
                }
                if m.Main || m.Path == "" {
                        continue // 跳过主模块（quail 自身）
                }
                d := dep{
                        Name:    m.Path,
                        Version: m.Version,
                        License: "unknown",
                        URL:     moduleURL(m.Path),
                }
                if m.Dir != "" {
                        if f := findLicenseFile(m.Dir); f != "" {
                                if b, err := os.ReadFile(f); err == nil {
                                        text := string(b)
                                        d.License = guessLicenseType(text)
                                        d.Copyright = extractCopyright(text)
                                }
                        }
                }
                deps = append(deps, d)
        }

        sort.Slice(deps, func(i, j int) bool {
                return strings.ToLower(deps[i].Name) < strings.ToLower(deps[j].Name)
        })

        b, err := json.MarshalIndent(deps, "", "  ")
        if err != nil {
                fmt.Fprintln(os.Stderr, "licgen: marshal:", err)
                os.Exit(1)
        }
        b = append(b, '\n')
        if err := os.MkdirAll(filepath.Dir(*out), 0o755); err != nil {
                fmt.Fprintln(os.Stderr, "licgen: mkdir:", err)
                os.Exit(1)
        }
        if err := os.WriteFile(*out, b, 0o644); err != nil {
                fmt.Fprintln(os.Stderr, "licgen: write:", err)
                os.Exit(1)
        }
        fmt.Printf("[licgen] backend-deps=%d -> %s\n", len(deps), *out)
}

// findLicenseFile 在模块目录中查找 LICENSE / COPYING / NOTICE 类文件。
func findLicenseFile(dir string) string {
        entries, err := os.ReadDir(dir)
        if err != nil {
                return ""
        }
        for _, e := range entries {
                if e.IsDir() || !licFileRe.MatchString(strings.ToLower(e.Name())) {
                        continue
                }
                return filepath.Join(dir, e.Name())
        }
        return ""
}

// extractCopyright 从许可证文本中提取版权声明行（最多 3 行，去重、保持出现顺序）。
func extractCopyright(text string) string {
        var hits []string
        for _, raw := range strings.Split(text, "\n") {
                line := strings.TrimSpace(raw)
                if line == "" || len(line) > 200 {
                        continue
                }
                low := strings.ToLower(line)
                if !strings.Contains(low, "copyright") &&
                        !strings.Contains(low, "(c)") &&
                        !strings.Contains(line, "©") {
                        continue
                }
                dup := false
                for _, h := range hits {
                        if strings.ToLower(h) == low {
                                dup = true
                                break
                        }
                }
                if dup {
                        continue
                }
                hits = append(hits, line)
                if len(hits) >= 3 {
                        break
                }
        }
        return strings.Join(hits, "\n")
}

// guessLicenseType 从许可证文本轻量猜测常见标识。
func guessLicenseType(text string) string {
        head := text
        if len(head) > 8000 {
                head = head[:8000]
        }
        switch {
        case strings.Contains(head, "Apache License"):
                return "Apache-2.0"
        case strings.Contains(head, "Mozilla Public License"):
                return "MPL-2.0"
        case strings.Contains(head, "ISC License"), strings.Contains(head, "Permission to use, copy, modify, and/or distribute this software"):
                return "ISC"
        case strings.Contains(head, "MIT License"), strings.Contains(head, "Permission is hereby granted, free of charge"):
                return "MIT"
        case strings.Contains(head, "Redistribution and use in source and binary forms"):
                return "BSD"
        case strings.Contains(head, "Creative Commons"):
                return "CC"
        default:
                return "unknown"
        }
}

// moduleURL 返回模块的可访问主页地址：已知代码托管域名直接拼 https
// （模块主版本后缀 /vN 不是仓库路径的一部分，需剔除），其余回落 pkg.go.dev。
func moduleURL(path string) string {
        u := path
        if v := majorSuffixRe.FindString(u); v != "" {
                u = strings.TrimSuffix(u, v)
        }
        if strings.HasPrefix(u, "github.com/") ||
                strings.HasPrefix(u, "gitlab.com/") ||
                strings.HasPrefix(u, "gitee.com/") ||
                strings.HasPrefix(u, "bitbucket.org/") ||
                strings.HasPrefix(u, "golang.org/x/") ||
                strings.HasPrefix(u, "google.golang.org/") ||
                strings.HasPrefix(u, "go.uber.org/") {
                return "https://" + u
        }
        return "https://pkg.go.dev/" + u
}

var majorSuffixRe = regexp.MustCompile(`/v[2-9]+$`)
