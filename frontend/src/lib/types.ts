export type Mode = "source" | "split" | "preview";

export type ThemeId =
  | "ayu-dark"
  | "ayu-mirage"
  | "ayu-light"
  | "one-dark-pro"
  | "dracula"
  | "nord"
  | "tokyo-night"
  | "github-light"
  | "github-dark"
  | "solarized-light";

export type CountMode = "words" | "chars" | "auto";

export type Lang = "zh" | "en";

/** 缩进单位：制表符 / 2 空格 / 4 空格 */
export type IndentId = "tab" | "space2" | "space4";

/** 预览面板对外 API */
export interface PreviewApi {
  /** 滚动到指定块（align: start，可带偏移） */
  scrollToIndex(index: number, opts?: { offset?: number }): void;
  /** 读取当前滚动位置（面板隐藏前保存用） */
  getScrollTop(): number;
  /** 恢复滚动位置（面板重新显示时用） */
  setScrollTop(top: number): void;
  /** 第 index 块的文档偏移（同步插值用；未测量块为估计值） */
  getItemOffset(index: number): number;
  /** 第 index 块的渲染高度（未测量块为估计值） */
  getItemSize(index: number): number;
  /** 外部布局变化后手动触发重算（兼容保留） */
  refresh(): void;
}

/** 由 AST 顶层节点切分出的预览块 */
export interface PreviewBlock {
  /** 跨解析稳定的块标识（内容哈希 + 同类序号），驱动 keyed DOM 复用 */
  id: string;
  index: number;
  /** mdast 顶层节点类型：heading / paragraph / code / table ... */
  type: string;
  /** 由该子树渲染出的 HTML 片段 */
  html: string;
  /** 在源码中的起始行（1-based，含） */
  startLine: number;
  /** 在源码中的结束行（1-based，含） */
  endLine: number;
}

export interface OutlineItem {
  depth: number;
  text: string;
  /** 源码行号 */
  line: number;
  /** 对应的预览块下标 */
  blockIndex: number;
}
