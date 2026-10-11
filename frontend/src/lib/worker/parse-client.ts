/**
 * 解析 worker 客户端：生命周期（创建/消息/崩溃重建）与 stores 调度解耦。
 *
 * - 单例 worker；消息按到达顺序回调（worker 串行处理，响应天然有序，
 *   主线程不丢弃任何响应——增量补丁相对 worker 内部状态，跳过会错位）；
 * - rev 单调递增仅用于日志与调试对账，不做乱序丢弃；
 * - onerror（脚本崩溃等）/ WorkerError 消息 → 重建 worker + 通知调用方；
 *   重建后 worker 状态清零，调用方必须以 forceFull 重发。
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
  /** 是否有请求在途（发出 → 响应回齐） */
  busy(): boolean;
  /** 手动重建 worker（崩溃恢复路径） */
  restart(): void;
  /** 页面卸载时终止 */
  dispose(): void;
}

let revSeq = 0;

export function createParseClient(handlers: ParseClientHandlers): ParseClient {
  let worker: Worker | null = null;
  /** 在途请求数（发出 +1，全部响应回齐 -1；全量路径 batch...result 合计一次） */
  let outstanding = 0;
  let disposed = false;

  function spawn(): Worker {
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

  function restart(): void {
    if (disposed) return;
    worker?.terminate();
    worker = spawn();
  }

  function request(src: string, forceFull: boolean): number {
    if (disposed) return -1;
    if (!worker) worker = spawn();
    const rev = ++revSeq;
    outstanding++;
    worker.postMessage({ type: "parse", rev, src, forceFull });
    return rev;
  }

  function dispose(): void {
    disposed = true;
    worker?.terminate();
    worker = null;
  }

  return {
    request,
    restart,
    dispose,
    busy: () => outstanding > 0,
  };
}
