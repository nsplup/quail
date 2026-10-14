/**
 * 全量重建 worker：与增量解析 worker 并行的周期性全量重建。
 *
 * 职责单一：收到增量 worker 经 MessageChannel port 发来的 fullRequest 后，
 * 对该 src 做一次完整解析（parseMarkdown → rootToHast → buildBlocks），
 * 将全量解析基线经 port 直接回传给增量 worker——结构化克隆发生在两个
 * worker 之间，不经过主线程；主线程对该过程无感知（例行重建不产生
 * batch/result 消息，预览渲染不受影响）。
 *
 * 内容哈希去重：请求携带 contentHash(src)。仅当哈希与上次已解析内容不同
 * 才真正重建；同内容请求（打字后回退到基线内容、阈值倍数重复触发等）
 * 直接复用上次解析结果回传，避免无意义全量。重建结果是否被采纳由增量
 * worker 决定（校验 src 未漂移后原子替换旧 HAST 基线）。
 *
 * 解析异常只记日志：例行重建是漂移防护（best-effort），增量 worker 会在
 * 下一个阈值倍数处重新请求；真正影响正确性的漂移由增量 worker 的 10s
 * idle 自愈校验兜底（就地全量）。
 */
import "./dom-shim";

import { buildBlocks, parseMarkdown, rootToHast } from "../markdown/markdown-core";
import type { Root as MdastRoot } from "mdast";
import type { Root as HastRoot } from "hast";
import type { PreviewBlock } from "../types";
import type { RebuildPortIn, RebuildPortOut } from "./protocol";

/** worker 上下文收窄（tsconfig 为 DOM lib，self 类型不匹配） */
interface RebuildWorkerCtx {
  onmessage: ((e: MessageEvent) => void) | null;
}

const ctx = self as unknown as RebuildWorkerCtx;
let toIncrement: MessagePort | null = null;

/** 上次重建缓存（哈希 → 解析基线）：同内容请求免重建直接回传 */
let lastParsed: {
  hash: string;
  out: RebuildPortOut;
} | null = null;

function runFull(req: Extract<RebuildPortIn, { type: "fullRequest" }>): void {
  const port = toIncrement;
  if (!port) return;
  try {
    if (lastParsed && lastParsed.hash === req.hash) {
      // 内容未变：复用上次解析结果（无任何解析开销）
      port.postMessage(lastParsed.out);
      return;
    }
    const root: MdastRoot = parseMarkdown(req.src);
    const hast: HastRoot = rootToHast(root);
    const blocks: PreviewBlock[] = buildBlocks(root, req.src);
    const out: RebuildPortOut = { type: "fullState", src: req.src, root, hast, blocks };
    lastParsed = { hash: req.hash, out };
    port.postMessage(out);
  } catch (err) {
    // 例行重建失败可安全忽略：增量 worker 在下一个阈值倍数处重新请求
    console.warn("[rebuild] full parse failed:", err);
  }
}

ctx.onmessage = (e: MessageEvent) => {
  const msg = e.data as { type?: string; port?: MessagePort };
  if (!msg) return;
  if (msg.type === "reset") {
    // 主线程全量重置（横幅「重新加载」）：清空内容哈希缓存，
    // 下一次 fullRequest 强制重建（同内容也不再复用）
    lastParsed = null;
    return;
  }
  if (msg.type === "initRebuildPort" && msg.port) {
    toIncrement = msg.port;
    toIncrement.onmessage = (ev: MessageEvent<RebuildPortIn>) => {
      const req = ev.data;
      if (req && req.type === "fullRequest" && typeof req.src === "string" && typeof req.hash === "string") {
        runFull(req);
      }
    };
    toIncrement.start();
  }
};
