/**
 * 着色 worker 消息协议（主线程 hl-client ↔ highlight.worker）。
 *
 * 与 parse.worker 的 protocol.ts 分离：着色链路独立演进，互不阻塞。
 * 请求以主线程自增 id 关联；每个请求保证恰好一条响应（hl:ok / hl:skip）。
 */

/** 着色请求：code 为代码块原文（mdast code 节点的纯文本值） */
export interface HlRequest {
  type: "hl";
  id: number;
  /** 围栏信息串语言（小写；空串 = 未标注，按方案约定直接按纯文本展示） */
  lang: string;
  code: string;
}

export interface HlOk {
  type: "hl:ok";
  id: number;
  /** hljs 输出（转义文本 + class 标记 span），组件可直接 {@html} 渲染 */
  html: string;
  /** 结果来源：hot 内存缓存 / parse 本次解析 */
  from: "hot" | "parse";
}

export interface HlSkip {
  type: "hl:skip";
  id: number;
  /** nolang 语言不可用（未标注 / 未收录）/ toolarge 超大块 / error 解析异常 */
  reason: "nolang" | "toolarge" | "error";
}

export type HlIn = HlRequest;
export type HlOut = HlOk | HlSkip;
