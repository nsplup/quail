/**
 * 主线程 ↔ 解析 worker 的消息协议（结构化克隆，无 JSON 序列化开销）。
 *
 * 请求（主 → worker）：
 *   ParseRequest { rev, src, forceFull }
 *     - worker 内部维护解析状态（IncrementalParseState），按到达顺序串行处理；
 *     - forceFull=true 时全量重建（boot / 自愈 / 结构漂移兜底）。
 *   SetCountModeMsg { mode }
 *     - 切换字数统计口径：worker 只计算该口径（三策略解耦），同一内容哈希
 *       的该口径结果有缓存则直接回传，否则按当前内容重算后缓存再回传。
 *   ResetEmptyMsg {}
 *     - 文档为空白（trim 后为空）：解析无意义，主线程直接落地空结果，
 *       仅通知 worker 把内部状态重置为干净空基线（不解析、不回包）。
 *       重置后 root=null，下一次真实解析按冷启动全量走，保证一致性。
 *
 * 响应（worker → 主）：
 *   FullBatch    全量段列表分批回传（segStart=0 的第一批触发主线程整列表重建）
 *   ParseResult  最终结果：full=true → 汇总（totalSegments/blocks/outline/counts）；
 *                full=false → 增量：segments 携带被替换区间 [segStart, segCount) 的新段
 *   CountsMsg    口径切换回执（ParseResult.counts 与之同构：单口径 + 数值）
 *   WorkerError  worker 内部异常（主线程重建 worker + 全量重解析）
 *
 * 增量补丁的关键约定：
 *   worker 只回传被替换区间的段；未变段不重发 → 主线程 splice 后
 *   未变段对象引用保持稳定 → MarkdownNode 按 props 引用相等跳过子树
 *   （结构与 worker 内 head/tail 节点引用复用互补，两层增量缺一不可）。
 */
import type { HastSegment } from "../markdown/markdown-core";
import type { Root as HastRoot } from "hast";
import type { CountMode, PreviewBlock, OutlineItem } from "../types";
import type { Root as MdastRoot } from "mdast";

/** 字数统计负载（三策略解耦后只携带当前口径）：
 * worker 内按「当前口径」计算并按内容哈希缓存，切换口径时回传新口径结果 */
export interface Counts {
  /** 本次统计使用的口径（与主线程当前设置一致；切换过渡期可能短暂滞后） */
  mode: CountMode;
  /** 该口径下的统计值 */
  value: number;
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

/** 全量路径：段列表分批回传（防止单条巨消息撑爆 postMessage / 主线程单帧成本） */
export interface FullBatch {
  type: "batch";
  rev: number;
  /** 本批段在完整段列表中的起始下标（0 = 首批，主线程据此清空旧列表） */
  segStart: number;
  items: HastSegment[];
  /**
   * 冷启动全量（worker 实例内首次解析：boot / 崩溃重建后）→ true：
   * 主线程逐批落地 segments$（虚拟化按需挂载，无重放窗口）。
   * 例行全量（25 次增量阈值 / idle 自愈 / 空态兜底）→ false：
   * 主线程只缓冲批次，result 到达后原子采纳——不清空已有渲染，
   * 由 Svelte 原地 diff 复用 DOM（与旧主线程版全量更新行为一致）。
   */
  cold: boolean;
}

export interface ParseResult {
  type: "result";
  rev: number;
  /** true = 全量重建（配合 FullBatch）；false = 增量（segments 为补丁） */
  full: boolean;
  /** 完整段列表长度（调试对账用；渲染层直接消费 segments） */
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

/** 空白文档重置：不解析，仅把增量 worker 内部状态归零（无响应） */
export interface ResetEmptyMsg {
  type: "resetEmpty";
}

/** 全量重置（横幅「重新加载」）：不解析，仅把增量 worker 内部状态归零
 * （语义与 resetEmpty 相同；独立消息类型便于日志对账与后续差异化演进，无响应） */
export interface ResetMsg {
  type: "reset";
}

/** 切换字数统计口径（主 → worker）：
 * worker 只计算该口径；同一内容哈希的该口径结果已缓存则直接回传缓存值，
 * 否则按当前内容重算（优先复用块级增量结构）后缓存再回执。 */
export interface SetCountModeMsg {
  type: "setCountMode";
  mode: CountMode;
}

/** 字数统计回执（worker → 主）：口径切换的独立响应；
 * 解析路径的统计随 ParseResult.counts 携带（同构负载）。 */
export interface CountsMsg {
  type: "counts";
  mode: CountMode;
  value: number;
}

/* ---------------- 增量 worker ↔ 全量重建 worker（MessageChannel 直连） ----------------
 * 例行全量重建（SELF_HEAL_EVERY 阈值触发）不再由增量 worker 就地执行——大文档
 * 全量解析需数百毫秒到数秒，会阻塞后续增量请求（打字偶发卡顿的根源）。
 * 改为：增量 worker 通过 port 把重建请求发给独立的重建 worker；重建完成后
 * 结果经 port 直达增量 worker（结构化克隆发生在两个 worker 之间，不经过
 * 主线程），增量 worker 校验 src 未漂移后原子替换持有的旧 HAST 基线。 */

/** 增量 worker → 重建 worker：对指定 src 做一次完整解析。
 *  hash = contentHash(src)：重建 worker 据此跳过同内容的重复重建
 *  （内容未变时直接复用上次解析结果，避免无意义全量）。 */
export interface RebuildRequestMsg {
  type: "fullRequest";
  src: string;
  hash: string;
}

/** 重建 worker → 增量 worker：重建完成的全量解析基线 */
export interface RebuildStateMsg {
  type: "fullState";
  src: string;
  root: MdastRoot | null;
  hast: HastRoot;
  blocks: PreviewBlock[];
}

/** 主线程 → 两个 worker 的初始化消息：移交与对端直连的 MessageChannel port */
export interface InitRebuildPortMsg {
  type: "initRebuildPort";
  port: MessagePort;
}

export type RebuildPortIn = RebuildRequestMsg; // 重建 worker 收
export type RebuildPortOut = RebuildStateMsg; // 增量 worker 收

export type WorkerOut = FullBatch | ParseResult | CountsMsg | WorkerError;
export type WorkerIn =
  | ParseRequest
  | SetCountModeMsg
  | ResetEmptyMsg
  | ResetMsg
  | InitRebuildPortMsg;

/** 主线程 → 重建 worker：清空内容哈希缓存（横幅「重新加载」前的归零，
 * 下一次 fullRequest 强制重建，无响应） */
export interface RebuildResetMsg {
  type: "reset";
}
