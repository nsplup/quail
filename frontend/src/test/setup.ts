/**
 * Vitest 测试环境（node）：
 * - table-source 的 HTML 侧解析依赖 DOMParser 全局（主线程 WebView 中由
 *   宿主提供；node 测试环境由 linkedom 提供，与解析 worker 的 dom-shim
 *   同一实现）；
 * - encodeCell → compileMarkdown 链路（unified / rehype-raw）与 worker 相同，
 *   历史上传递依赖曾触发 document 未定义 → 复用 worker 的 dom-shim 建立
 *   最小全局兜底（不进主 bundle，仅测试环境加载）。
 */
import { DOMParser as LinkedomDOMParser } from "linkedom";
import "../lib/worker/dom-shim";

const g = globalThis as unknown as Record<string, unknown>;
if (g.DOMParser === undefined) {
  g.DOMParser = LinkedomDOMParser;
}
