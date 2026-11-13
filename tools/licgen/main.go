// Package main —— licgen：构建期后端依赖许可信息收集器。
//
// 用法（在 frontend 目录下，见 build/Taskfile.yml build:frontend）：
//
//	go run ../tools/licgen -out src/lib/generated/backend-deps.json
//
// 以 `go list -m -json all` 枚举全部 Go 模块（含间接依赖与 wails 框架本体），
// 从模块缓存（$GOMODCACHE/<mod>@<ver>）中查找 LICENSE / COPYING / NOTICE 类
// 文件，自动提取许可证标识、版权声明与许可证全文（合规要求再分发时附带
// 许可证正文），输出按名称排序的 JSON 数组，供前端「开源许可」页面直接
// import（与 generate-build-info.mjs 的前端依赖清单同构）。
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
	Name        string `json:"name"`
	Version     string `json:"version"`
	License     string `json:"license"`
	Copyright   string `json:"copyright"`
	URL         string `json:"url"`
	LicenseText string `json:"licenseText,omitempty"`
}

// module 是 `go list -m -json` 输出中用到的字段子集。
type module struct {
	Path    string
	Version string
	Dir     string
	Main    bool
}

var licFileRe = regexp.MustCompile(`^(licen[cs]e|copying|copyright|notice|unlicense)(\..*)?$`)
var ccRe = regexp.MustCompile(`(?i)CC0[- ]?1\.0|CC[- ]BY[- ]?(?:SA|NC|ND)?[- ]?[0-9.]+`)

func main() {
	out := flag.String("out", "frontend/src/lib/generated/backend-deps.json", "输出 JSON 路径")
	flag.Parse()

	// 预下载全部模块：`go list` 只对已进入模块缓存的包输出 Dir，
	// CI 全新环境不预下载会导致整批依赖拿不到许可证文件（license=unknown）。
	// 失败不阻断——本地已有缓存的模块仍可正常处理。
	dl := exec.Command("go", "mod", "download", "all")
	dl.Stderr = os.Stderr
	_ = dl.Run()

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
			files := findLicenseFiles(m.Dir)
			if len(files) > 0 {
				// 标识 / 版权行以首个（主）许可证文件为准
				if b, err := os.ReadFile(files[0]); err == nil {
					text := string(b)
					d.License = guessLicenseType(text)
					d.Copyright = extractCopyright(text)
				}
				// 正文合并收集全部许可证文件（双许可包每一份都要随分发带上）
				d.LicenseText = extractLicenseText(files)
			}
		}
		deps = append(deps, d)
	}

	sort.Slice(deps, func(i, j int) bool {
		return strings.ToLower(deps[i].Name) < strings.ToLower(deps[j].Name)
	})

	b, err := json.MarshalIndent(deps, "", " ")
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

// findLicenseFiles 在模块目录中查找全部 LICENSE / COPYING / NOTICE 类文件
// （按目录条目顺序返回，首个视为主许可证）。
func findLicenseFiles(dir string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var files []string
	for _, e := range entries {
		if e.IsDir() || !licFileRe.MatchString(strings.ToLower(e.Name())) {
			continue
		}
		files = append(files, filepath.Join(dir, e.Name()))
	}
	return files
}

// extractLicenseText 读取并合并（去重后）全部许可证文件正文。
// 同一包可能携带多份许可（如 MIT + BSD 双许可），合规分发要求全部附带。
func extractLicenseText(files []string) string {
	var parts []string
	seen := map[string]bool{}
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		text := strings.TrimSpace(string(b))
		if text == "" {
			continue
		}
		key := strings.ToLower(text)
		if seen[key] {
			continue
		}
		seen[key] = true
		if len(parts) > 0 {
			parts = append(parts, strings.Repeat("-", 40))
		}
		parts = append(parts, text)
	}
	return strings.Join(parts, "\n")
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
		if !strings.Contains(low, "copyright") && !strings.Contains(low, "(c)") && !strings.Contains(line, "©") {
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

// guessLicenseType 从许可证文本轻量猜测常见 SPDX 标识。
// 注意分支顺序：GPL 家族的标志短语不含 MIT/BSD 的惯用句，安全；
// 0BSD 与 ISC 正文几乎相同，靠是否带 "provided that" 条款区分。
func guessLicenseType(text string) string {
	head := text
	if len(head) > 8000 {
		head = head[:8000]
	}
	low := strings.ToLower(head)
	switch {
	case strings.Contains(head, "Apache License"):
		return "Apache-2.0"
	case strings.Contains(head, "Mozilla Public License"):
		if strings.Contains(head, "1.1") {
			return "MPL-1.1"
		}
		return "MPL-2.0"
	case strings.Contains(head, "GNU Affero General Public License"):
		return "AGPL-3.0"
	case strings.Contains(head, "GNU Lesser General Public License"),
		strings.Contains(head, "GNU Library General Public License"):
		if strings.Contains(head, "2.1") {
			return "LGPL-2.1"
		}
		return "LGPL-3.0"
	case strings.Contains(head, "GNU General Public License"):
		if strings.Contains(head, "Version 2") || strings.Contains(head, "version 2") {
			return "GPL-2.0"
		}
		return "GPL-3.0"
	case strings.Contains(low, "zero-clause bsd"), strings.Contains(low, "0bsd"),
		strings.Contains(head, "Permission to use, copy, modify, and/or distribute this software"):
		if !strings.Contains(low, "provided that") {
			return "0BSD"
		}
		return "ISC"
	case strings.Contains(head, "ISC License"),
		strings.Contains(head, "Permission to use, copy, modify, and/or distribute this software"):
		return "ISC"
	case strings.Contains(head, "MIT License"),
		strings.Contains(head, "Permission is hereby granted, free of charge"):
		return "MIT"
	case strings.Contains(head, "The Unlicense"), strings.Contains(low, "unlicense"):
		return "Unlicense"
	case strings.Contains(head, "Boost Software License"):
		return "BSL-1.0"
	case strings.Contains(head, "This software is provided 'as-is', without any express"):
		return "Zlib"
	case strings.Contains(head, "Blue Oak"):
		return "BlueOak-1.0.0"
	case strings.Contains(head, "Redistribution and use in source and binary forms"):
		return guessBSDVariant(low)
	case strings.Contains(head, "Creative Commons"):
		return guessCC(head)
	default:
		return "unknown"
	}
}

// guessBSDVariant 按「广告子句」「非背书子句」的有无区分 BSD-4/3/2-Clause。
func guessBSDVariant(low string) string {
	switch {
	case strings.Contains(low, "advertising materials"):
		return "BSD-4-Clause"
	case strings.Contains(low, "endorse or promote"):
		return "BSD-3-Clause"
	default:
		return "BSD-2-Clause"
	}
}

// guessCC 提取 CC 许可的具体变体与版本（如 CC-BY-4.0 / CC0-1.0）。
func guessCC(text string) string {
	if m := ccRe.FindString(text); m != "" {
		return strings.ToUpper(m)
	}
	return "CC"
}

// moduleURL 返回模块的可访问主页地址：已知代码托管域名直接拼 https
// （模块主版本后缀 /vN 不是仓库路径的一部分，需剔除），其余回落 pkg.go.dev。
func moduleURL(path string) string {
	u := path
	if v := majorSuffixRe.FindString(u); v != "" {
		u = strings.TrimSuffix(u, v)
	}
	if strings.HasPrefix(u, "github.com/") || strings.HasPrefix(u, "gitlab.com/") ||
		strings.HasPrefix(u, "gitee.com/") || strings.HasPrefix(u, "bitbucket.org/") ||
		strings.HasPrefix(u, "golang.org/x/") || strings.HasPrefix(u, "google.golang.org/") ||
		strings.HasPrefix(u, "go.uber.org/") {
		return "https://" + u
	}
	return "https://pkg.go.dev/" + u
}

var majorSuffixRe = regexp.MustCompile(`/v[2-9]+$`)
