/**
 * Worker 环境的 DOM shim（linkedom）。
 *
 * - worker 全局不存在 document/window，而解析链路的传递依赖（rehype-raw →
 *   parse5 一族）历史上曾触发 document 未定义报错；本模块在 worker 入口的
 *   第一个 import 位求值，先于所有解析库建立全局兜底；
 * - linkedom 是纯 JS 轻量实现（~几十 KB），只打包进 worker chunk，
 *   主 bundle 零增量；shim 仅覆盖最小全局集合，正常解析路径不触达 DOM；
 * - 若后续某依赖需要更多全局（如 navigator 的特定字段），在此按需追加。
 */
import { parseHTML } from "linkedom";

const dom = parseHTML("<!DOCTYPE html><html><head></head><body></body></html>");
const d = dom as unknown as Record<string, unknown>;

const g = globalThis as unknown as Record<string, unknown>;
for (const key of [
  "window",
  "document",
  "Node",
  "Element",
  "Text",
  "Comment",
  "DocumentFragment",
  "Document",
  "HTMLElement",
  "SVGElement",
  "CustomEvent",
  "Event",
] as const) {
  if (d[key] !== undefined && g[key] === undefined) g[key] = d[key];
}
