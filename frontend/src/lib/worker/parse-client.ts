/**
 * 解析 worker 客户端：双 worker 生命周期（创建 / 消息 / 崩溃重建）与 stores 调度解耦。
 *
 * 架构（增量解析与全量重建分离）：
 * - 增量 worker（parse.worker.ts，实时响应）：维护 IncrementalParseState，
 *   串行处理编辑请求，回传段级补丁；冷启动/强制/idle 自愈时就地全量；
 * - 重建 worker（full.worker.ts，周期性）：承接例行周期全量重建（阈值触发，
 *   增量 worker 携带内容哈希经 MessageChannel port 直连请求），重建基线经
 *   port 直达增量 worker 原子替换旧 HAST——全程不经主线程，打字响应不受
 *   全量解析耗时影响；同内容请求（内容哈希相同）由重建 worker 复用上次
 *   结果，不做无意义重建；
 * - 主线程消息按到达顺序回调（增量 worker 串行处理，响应天然有序，主线程
 *   不丢弃任何响应——增量补丁相对 worker 内部状态，跳过会错位）；
 * - rev 单调递增仅用于日志与调试对账，不做乱序丢弃；
 * - 增量 worker onerror（脚本崩溃等）/ WorkerError 消息 → 重建 + 通知调用方；
 *   重建后 worker 状态清零，调用方必须以 forceFull 重发。重建 worker 崩溃
 *   静默重启并重新布线（例行重建是 best-effort，不影响正确性）。
 */
import type { FullBatch, ParseResult, WorkerError, WorkerOut } from "./protocol";

export interface ParseClientHandlers {
  /** 全量段批次（渐进渲染在批次到达期间即可推进） */
  onBatch: (msg: FullBatch) => void;
  /** 解析结果（full=true 汇总 / full=false 增量补丁） */
  onResult: (msg: ParseResult) => void;
  /** worker 内部异常（调用方负责 toast + forceFull 重发） */
  onWorkerError: (msg: WorkerError) => void;
  /** worker 脚本级崩溃（调用方负责 toast + forceFull 重发） */
  onCrashed: () => void;
}

export interface ParseClient {
  /** 发送解析请求；返回本次 rev */
  request(src: string, forceFull: boolean): number;
  /** 空白文档重置：通知增量 worker 把内部状态归零（不解析、不回包、不计在途） */
  resetEmpty(): void;
  /** 是否有请求在途（发出 → 响应回齐） */
  busy(): boolean;
  /** 手动重建增量 worker（崩溃恢复路径） */
  restart(): void;
  /** 页面卸载时终止 */
  dispose(): void;
}

let revSeq = 0;

export function createParseClient(handlers: ParseClientHandlers): ParseClient {
  let worker: Worker | null = null; // 增量 worker
  let rebuildWorker: Worker | null = null; // 全量重建 worker
  let channel: MessageChannel | null = null;
  /** 在途请求数（发出 +1，全部响应回齐 -1；全量路径 batch...result 合计一次） */
  let outstanding = 0;
  let disposed = false;

  function spawnIncrement(): Worker {
    const w = new Worker(new URL("./parse.worker.ts", import.meta.url), {
      type: "module",
      name: "quail-parse",
    });
    w.onmessage = (e: MessageEvent<WorkerOut>) => {
      const msg = e.data;
      if (!msg) return;
      if (msg.type === "batch") {
        handlers.onBatch(msg);
        return;
      }
      if (msg.type === "result") {
        outstanding = Math.max(0, outstanding - 1);
        handlers.onResult(msg);
        return;
      }
      // type === "error"：worker 内部异常。状态可能已损坏 → 重建 + forceFull
      outstanding = 0;
      handlers.onWorkerError(msg);
      restart();
    };
    w.onerror = () => {
      // 脚本级崩溃（加载失败/顶层异常）：重建，交由调用方全量重解析
      outstanding = 0;
      handlers.onCrashed();
      restart();
    };
    w.onmessageerror = () => {
      // 结构化克隆失败（不可克隆数据）：极罕见，按崩溃恢复
      outstanding = 0;
      handlers.onCrashed();
      restart();
    };
    return w;
  }

  function spawnRebuild(): Worker {
    const w = new Worker(new URL("./full.worker.ts", import.meta.url), {
      type: "module",
      name: "quail-rebuild",
    });
    // 重建 worker 不与主线程通信；崩溃静默重启并重新布线（best-effort）
    w.onerror = () => {
      console.warn("[parse] rebuild worker crashed; restarting");
      if (!disposed) restartRebuild();
    };
    return w;
  }

  /** 布线增量 worker ↔ 重建 worker 的直连通道（任一端重建后整体重连） */
  function wireChannel(): void {
    channel?.port1.close();
    channel?.port2.close();
    channel = new MessageChannel();
    worker?.postMessage({ type: "initRebuildPort", port: channel.port1 }, [channel.port1]);
    rebuildWorker?.postMessage({ type: "initRebuildPort", port: channel.port2 }, [channel.port2]);
  }

  function spawnAll(): void {
    worker = spawnIncrement();
    rebuildWorker = spawnRebuild();
    wireChannel();
  }

  function restart(): void {
    if (disposed) return;
    worker?.terminate();
    worker = spawnIncrement();
    wireChannel();
  }

  function restartRebuild(): void {
    if (disposed) return;
    rebuildWorker?.terminate();
    rebuildWorker = spawnRebuild();
    wireChannel();
  }

  function request(src: string, forceFull: boolean): number {
    if (disposed) return -1;
    if (!worker || !rebuildWorker) spawnAll();
    const rev = ++revSeq;
    outstanding++;
    worker!.postMessage({ type: "parse", rev, src, forceFull });
    return rev;
  }

  /** 空白文档重置：fire-and-forget（不解析不回包），不计入在途请求 */
  function resetEmpty(): void {
    if (disposed) return;
    if (!worker || !rebuildWorker) spawnAll();
    worker!.postMessage({ type: "resetEmpty" });
  }

  /**
   * 全量重置（横幅「重新加载」）：增量 worker 解析基线归零（下一次解析
   * 冷启动全量）+ 重建 worker 内容哈希缓存清空（同内容也强制重建）。
   * fire-and-forget，不计入在途请求；worker 尚未创建时无需重置
   * （惰性创建即干净状态），也不主动拉起。
   */
  function reset(): void {
    if (disposed) return;
    worker?.postMessage({ type: "reset" });
    rebuildWorker?.postMessage({ type: "reset" });
  }

  function dispose(): void {
    disposed = true;
    worker?.terminate();
    worker = null;
    rebuildWorker?.terminate();
    rebuildWorker = null;
    channel = null;
  }

  return {
    request,
    resetEmpty,
    reset,
    restart,
    dispose,
    busy: () => outstanding > 0,
  };
}
