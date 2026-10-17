package main

// write_guard.go 单元测试：自身写入回环抑制（登记→命中核销 / 未命中放行 /
// TTL 过期清理）。

import (
	"testing"
	"time"
)

func TestWriteGuard_ClaimHit(t *testing.T) {
	g := newWriteGuard()
	g.begin("tok1", "digest-a")
	if !g.claim("digest-a") {
		t.Fatal("登记写入的哈希应命中并核销")
	}
	// 核销后同一哈希不再命中（一次性）
	if g.claim("digest-a") {
		t.Fatal("已核销的令牌不应再次命中")
	}
}

func TestWriteGuard_ClaimMiss(t *testing.T) {
	g := newWriteGuard()
	g.begin("tok1", "digest-a")
	// 外部修改（哈希未登记）→ 放行广播
	if g.claim("digest-external") {
		t.Fatal("未登记哈希不应命中")
	}
	// 放行不应误删登记
	if !g.claim("digest-a") {
		t.Fatal("放行外部修改后，原登记仍应可用")
	}
}

func TestWriteGuard_PruneExpired(t *testing.T) {
	g := newWriteGuard()
	// 注入过期登记（模拟监听降级收不到回环事件的场景）
	g.mu.Lock()
	g.pending["old"] = writeEntry{digest: "digest-old", at: time.Now().Add(-writeTokenTTL - time.Second)}
	g.mu.Unlock()
	// 过期令牌不命中，且被清理
	if g.claim("digest-old") {
		t.Fatal("过期令牌不应命中")
	}
	g.mu.Lock()
	_, exists := g.pending["old"]
	g.mu.Unlock()
	if exists {
		t.Fatal("过期令牌应被 prune 清理")
	}
}

func TestWriteGuard_MultiplePending(t *testing.T) {
	g := newWriteGuard()
	g.begin("tok1", "digest-a")
	g.begin("tok2", "digest-b")
	// 两个不同内容登记互不影响
	if !g.claim("digest-b") {
		t.Fatal("第二个登记应命中")
	}
	if !g.claim("digest-a") {
		t.Fatal("第一个登记应命中")
	}
}
