/**
 * 兼容再导出层：Markdown 解析管线已整体迁入 worker 线程
 * （实现见 ./markdown/markdown-core.ts，消息协议见 ./worker/protocol.ts）。
 *
 * - 主线程只保留：段级补丁应用所需的类型 + 块映射/文本统计纯函数
 *   （blocks.ts，零依赖，不会把 unified 生态打进主 bundle）；
 * - HastSegment 等类型为 type-only 再导出，编译期擦除，无运行时代价。
 */
export type {
  HastSegment,
  IncrementalParseState,
  IncrementalParseResult,
  SegmentPatchRange,
} from "./markdown/markdown-core";
export {
  blockIndexForLine,
  blocksCoverDoc,
  countTextAs,
} from "./markdown/blocks";
