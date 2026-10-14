export type Mode = "source" | "split" | "preview";

/**
 * 启动时的默认布局：
 * - memory：记住上次的布局（mode 持久化，即历史行为）；
 * - source / split / preview：每次启动固定使用指定布局。
 */
export type DefaultLayout = "memory" | "source" | "split" | "preview";

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
  | "solarized-light"
  | "catppuccin-mocha"
  | "catppuccin-latte"
  | "rose-pine"
  | "gruvbox-dark"
  | "gruvbox-light"
  | "night-owl"
  | "palenight"
  | "monokai-pro"
  | "material-theme"
  | "vitesse-dark"
  | "vitesse-light"
  | "everforest-dark"
  | "everforest-light"
  | "one-light"
  | "alabaster";

export type CountMode = "words" | "chars" | "auto";

/** 预览解析阶段（底栏指示数据源；渲染随结果落地即时完成，无独立渲染阶段） */
export type ParsePhase = "idle" | "parsing";

/**
 * 解析触发上下文（底栏解析状态指示器区分展示规则用）：
 * - open：打开文档触发（冷启动 / 磁盘重载）——「解析中」无启动阈值，出现后至少停留 500ms；
 * - blank-open：打开的是空白文档——指示器直接使用「准备就绪」；
 * - edit：编辑触发——解析持续超过 200ms 才显示「解析中」，出现后至少停留 500ms。
 */
export type ParseContext = "open" | "blank-open" | "edit";

export type Lang = "zh" | "en";

/**
 * 语言设置（设置面板持久化的原始值）：
 * - system：跟随系统语言（默认项）；
 * - zh / en：指定语言。
 * 解析规则见 i18n.svelte.ts 的 resolveLang（解析结果超出可用语言时回落英语）。
 */
export type LangSetting = "system" | Lang;

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

/** 由 AST 顶层节点切分出的预览块（行界映射单元；渲染由 Svelte 组件树完成） */
export interface PreviewBlock {
  index: number;
  /** mdast 顶层节点类型：heading / paragraph / code / table ... */
  type: string;
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
