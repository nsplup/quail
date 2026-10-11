/**
 * 主线程 ↔ 解析 worker 的消息协议（结构化克隆，无 JSON 序列化开销）。
 *
 * 请求（主 → worker）：
 *   ParseRequest { rev, src, forceFull }
 *     - worker 内部维护解析状态（IncrementalParseState），按到达顺序串行处理；
 *     - forceFull=true 时全量重建（boot / 自愈 / 结构漂移兜底）。
 *
 * 响应（worker → 主）：
 *   FullBatch    全量段列表分批回传（segStart=0 的第一批触发主线程整列表重建）
 *   ParseResult  最终结果：full=true → 汇总（totalSegments/blocks/outline/counts）；
 *                full=false → 增量：segments 携带被替换区间 [segStart, segCount) 的新段
 *   WorkerError  worker 内部异常（主线程重建 worker + 全量重解析）
 *
 * 增量补丁的关键约定：
 *   worker 只回传被替换区间的段；未变段不重发 → 主线程 splice 后
 *   未变段对象引用保持稳定 → MarkdownNode 按 props 引用相等跳过子树
 *   （结构与 worker 内 head/tail 节点引用复用互补，两层增量缺一不可）。
 */
import type { HastSegment } from "../markdown/markdown-core";
import type { PreviewBlock, OutlineItem } from "../types";

export interface Counts {
  /** 英文单词数 */
  words: number;
  /** 汉字数 */
  hanChars: number;
}

export interface ParseRequest {
  type: "parse";
  /** 单调递增序号（主线程生成；worker 原样回传） */
  rev: number;
  src: string;
  forceFull: boolean;
}

/** 段级补丁：用 items 替换主线程段列表的 [segStart, segStart + segCount) */
export interface SegmentPatch {
  segStart: number;
  segCount: number;
  items: HastSegment[];
}

/** 全量路径：段列表分批回传（防止单条巨消息 + 支撑渐进渲染进度） */
export interface FullBatch {
  type: "batch";
  rev: number;
  /** 本批段在完整段列表中的起始下标（0 = 首批，主线程据此清空旧列表） */
  segStart: number;
  items: HastSegment[];
}

export interface ParseResult {
  type: "result";
  rev: number;
  /** true = 全量重建（配合 FullBatch）；false = 增量（segments 为补丁） */
  full: boolean;
  /** 完整段列表长度（渐进渲染进度分母） */
  totalSegments: number;
  /** full=true 时无意义；full=false 时为段级补丁 */
  segments: SegmentPatch;
  blocks: PreviewBlock[];
  outline: OutlineItem[];
  counts: Counts;
}

export interface WorkerError {
  type: "error";
  rev: number;
  message: string;
}

export type WorkerOut = FullBatch | ParseResult | WorkerError;
export type WorkerIn = ParseRequest;
