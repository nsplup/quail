/**
 * 着色 worker 客户端（主线程桥）：单例 worker + 请求表 + 超时/崩溃降级。
 *
 * 模式沿用 lib/worker/parse-client.ts，职责裁剪到最简：
 * - 单例 worker（首次请求惰性创建；崩溃后置空，下次请求惰性重建）；
 * - 请求以自增 id 关联，每请求 10s 超时兜底：超时仅本请求降级纯文本，
 *   不终止 worker（着色是纯视觉增强，任何失败都不得影响预览可用性）；
 * - 组件侧无缓存状态（权威缓存在 worker：单级内存 LRU，无持久化），
 *   本模块只做请求/响应关联与降级。
 */
import type { HlIn, HlOut } from "./protocol";

/** 着色结果：HTML 字符串；null = 降级纯文本（skip / 超时 / worker 不可用） */
export type HlResult = string | null;

let worker: Worker | null = null;
let nextId = 1;
const pendingReq = new Map<number, { resolve: (r: HlResult) => void; timer: number }>();

function failAll(): void {
  for (const [, entry] of pendingReq) {
    clearTimeout(entry.timer);
    entry.resolve(null);
  }
  pendingReq.clear();
}

function ensureWorker(): Worker | null {
  if (worker) return worker;
  try {
    worker = new Worker(new URL("./highlight.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (e: MessageEvent<HlOut>) => {
      const msg = e.data;
      if (!msg || (msg.type !== "hl:ok" && msg.type !== "hl:skip")) return;
      const entry = pendingReq.get(msg.id);
      if (!entry) return; // 已超时降级的过期响应，丢弃
      pendingReq.delete(msg.id);
      clearTimeout(entry.timer);
      entry.resolve(msg.type === "hl:ok" ? msg.html : null);
    };
    worker.onerror = () => {
      failAll();
      try {
        worker?.terminate();
      } catch {
        /* 已终止或从未启动 */
      }
      worker = null; // 下次请求惰性重建
    };
  } catch {
    worker = null;
  }
  return worker;
}

export function requestHighlight(lang: string, code: string, timeoutMs = 10_000): Promise<HlResult> {
  const w = ensureWorker();
  if (!w) return Promise.resolve(null);
  return new Promise((resolve) => {
    const id = nextId++;
    const timer = window.setTimeout(() => {
      pendingReq.delete(id);
      resolve(null);
    }, timeoutMs);
    pendingReq.set(id, { resolve, timer });
    const msg: HlIn = { type: "hl", id, lang, code };
    w.postMessage(msg);
  });
}
