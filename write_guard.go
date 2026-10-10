package main

// 写入令牌 + 内容哈希：ConfigService / FileService 共用的自身写入抑制机制。
//
// 旧方案为时间窗布尔标记（写入后 N 毫秒内一律视为自身写入），存在两类误判：
//   - fsnotify 事件投递 + 防抖耗时超出时间窗 → 自身写入被当作外部修改广播（回环）；
//   - 时间窗内外部恰好写盘 → 外部修改被误抑制（丢更新）。
//
// 新方案：每次自身写入先登记一个唯一令牌与落盘内容的 sha256；watch 防抖触发时
// 读取磁盘内容并核对哈希——命中登记 → 判定为自身写入回环，抑制广播并清除该令牌；
// 未命中 → 外部修改，放行广播。令牌带 TTL，监听降级等收不到回环事件的场景下
// 过期自动清理，不会无限累积。

import (
	"crypto/rand"
	"encoding/hex"
	"sync"
	"time"
)

// writeTokenTTL 令牌有效期：仅需覆盖 fsnotify 事件投递 + 防抖窗口的正常上限，
// 超时未核对（如监听降级）即视为失效。
const writeTokenTTL = 10 * time.Second

// writeEntry 一次待核对的自身写入。
type writeEntry struct {
	digest string    // 落盘内容的 sha256（hex）
	at     time.Time // 登记时刻（TTL 清理用）
}

// writeGuard 自身写入抑制登记簿：token → 内容指纹。
type writeGuard struct {
	mu      sync.Mutex
	pending map[string]writeEntry
}

func newWriteGuard() *writeGuard {
	return &writeGuard{pending: make(map[string]writeEntry)}
}

// newWriteToken 生成一次写入的唯一令牌。
func newWriteToken() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		// 极端降级：熵源不可用时退化为纳秒时间戳，仍保证令牌唯一性
		return hex.EncodeToString([]byte(time.Now().Format("20060102150405.000000000")))
	}
	return hex.EncodeToString(b)
}

// begin 登记一次自身写入（落盘前调用；digest 为实际写入字节的 sha256）。
func (g *writeGuard) begin(token, digest string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.pending == nil {
		g.pending = make(map[string]writeEntry)
	}
	g.pruneLocked()
	g.pending[token] = writeEntry{digest: digest, at: time.Now()}
}

// claim 以磁盘内容哈希核对：命中任一登记写入 → 清除该令牌并返回 true
// （自身写入回环，抑制广播）；未命中 → 返回 false（外部修改，放行广播）。
func (g *writeGuard) claim(digest string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.pruneLocked()
	for token, e := range g.pending {
		if e.digest == digest {
			delete(g.pending, token)
			return true
		}
	}
	return false
}

// pruneLocked 清理过期令牌。必须持 g.mu。
func (g *writeGuard) pruneLocked() {
	now := time.Now()
	for token, e := range g.pending {
		if now.Sub(e.at) > writeTokenTTL {
			delete(g.pending, token)
		}
	}
}
