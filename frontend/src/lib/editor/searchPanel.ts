/**
 * 查找/替换悬浮面板（右上角绝对定位卡片，不再占用编辑区高度）。
 *
 * - 面板 DOM 由本模块全权管理（挂在 body 上），不再走 CM6 的
 *   search({ createPanel }) 挂载点——预览模式下依然可见可用；
 * - 编辑区仍走 CM6 原生搜索管线：SearchQuery / setSearchQuery /
 *   findNext / replaceNext（匹配高亮由 search() 扩展的 SearchHighlighter
 *   提供，无需面板在场）；面板打开时编辑区顶部余量由
 *   EditorView.scrollMargins 动态让出（见 codemirrorSetup）；
 * - 预览区来源：匹配列表 / 当前项下标与编辑区独立（见
 *   preview/previewSearch.ts），切换当前项的滚动由本模块自行实现；
 * - 当前项来源依赖打开面板时的布局模式：源码/双栏 → 编辑区，
 *   预览 → 预览区；来源切换时目标来源不可用则先切到双栏；
 * - 来源只决定当前项（导航/滚动/状态栏下标）在哪边，不影响预览区
 *   装饰器：面板打开且预览区有匹配时装饰恒生效，来源=编辑区时
 *   预览区只高亮全部匹配、不标当前项（current = -1）；
 * - 面板正则安全校验（见 preview/previewSearch.ts checkRegexSafety）：
 *   ReDoS / 零宽模式被拦截时向编辑区同步空查询停用搜索管线，
 *   状态栏显示拦截提示，编辑区与预览区均不再执行该正则。
 *
 * 布局（成块从左到右，行内换行在块内处理）：
 *   [查找栏(内嵌三枚匹配条件按钮) / 替换栏]
 *   [跨行结果提示文本：上=当前项下标，下=列表数量，中=分隔线]
 *   [↑↓ 按钮组 / 替换按钮组] [关闭按钮 / 切换当前项来源按钮]
 */
import {
  SearchQuery,
  setSearchQuery,
  findNext,
  findPrevious,
  replaceNext,
  replaceAll,
  openSearchPanel,
  closeSearchPanel,
} from "@codemirror/search";
import type { EditorView, ViewUpdate } from "@codemirror/view";
import { writable, get } from "svelte/store";
import { locale } from "svelte-i18n";
import { mode$, previewApi$, segments$, topIndex$ } from "../stores";
import { confirm$, dialogMask$ } from "../confirm";
import type { Mode } from "../types";
import { t } from "../i18n.svelte";
import {
  buildPreviewPattern,
  checkRegexSafety,
  computePreviewMatches,
  setPreviewSearchState,
  resetPreviewSearchState,
  type PreviewMatchInfo,
  type RegexSafetyIssue,
  type SearchSource,
} from "../preview/previewSearch";

/** 面板开合状态（App 侧联动编辑区 scrollMargins 用） */
export const searchPanelOpen$ = writable(false);

/** 面板打开时给滚动定位留出的顶部余量（面板高 + 间距） */
const PANEL_GAP = 12;
/** 匹配列表显示上限（与旧面板/预览区口径一致） */
const MATCH_CAP = 999;

/* ------------------------------------------------------------------
 *  DOM 工具与图标
 * ------------------------------------------------------------------ */

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  textContent?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (textContent != null) node.textContent = textContent;
  return node;
}

/** feather 风格描边 SVG（与组件内 Icon.svelte 同一视觉语言） */
function svg(paths: string, size = 14): string {
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" ` +
    `stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`
  );
}

/** 填充风格 SVG（16×16 viewBox，随主题色 currentColor；style 可选内联样式） */
function svgFill(inner: string, size = 15, style = ""): string {
  const st = style ? ` style="${style}"` : "";
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 16 16"${st} ` +
    `fill="currentColor" aria-hidden="true">${inner}</svg>`
  );
}

/** 用户提供的匹配条件图标（16×16 fill 风格，1em 尺寸随字号） */
function svgCond(inner: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" ` +
    `viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">${inner}</svg>`
  );
}

const ICONS = {
  up: svg('<polyline points="18 15 12 9 6 15"></polyline>'),
  down: svg('<polyline points="6 9 12 15 18 9"></polyline>'),
  close: svg('<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>'),
  /* 替换（用户提供的 replace 图标，fill 风格）；图标右移 3px 平衡视觉 */
  replaceOne: svgFill(
    '<g><path fill-rule="evenodd" d="M10 2.813a1.8 1.8 0 0 1 1-.313c1.103 0 2 1.009 2 2.25S12.103 7 11 7c-.38 0-.731-.127-1.034-.334A.495.495 0 0 1 9.5 7a.5.5 0 0 1-.5-.5v-5a.5.5 0 0 1 1 0zm0 1.937c0 .689.448 1.25 1 1.25s1-.561 1-1.25s-.448-1.25-1-1.25s-1 .561-1 1.25M2 9h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1m3.039 4.645c-.229.204-.84.323-1.209-.139a1.62 1.62 0 0 1-.33-1.014c0-.388.118-.748.33-1.014c.371-.464.981-.345 1.21-.139a.5.5 0 1 0 .669-.742c-.787-.71-1.976-.596-2.66.256a2.63 2.63 0 0 0-.549 1.639c0 .614.195 1.196.549 1.639c.381.474.896.736 1.451.736a1.8 1.8 0 0 0 1.208-.48a.5.5 0 1 0-.669-.742" clip-rule="evenodd"/><path d="M4 4.5C4 3.673 4.673 3 5.5 3h2.002a.5.5 0 0 1 0 1h-2a.5.5 0 0 0-.5.5v1.793l1.146-1.146a.5.5 0 0 1 .707.707l-2 2a.5.5 0 0 1-.708 0l-2-2a.5.5 0 0 1 .707-.707L4 6.293z"/></g>',
    15,
    "transform: translate3d(3px, 0, 0);"
  ),
  /* 全部替换（用户提供的 replace-all 图标，fill 风格） */
  replaceAll: svgFill(
    '<g><path d="M14 13v-3c0-1.65-1.35-3-3-3H5.12l-1 1H11c1.1 0 2 .9 2 2v4c.55 0 1-.45 1-1"/><path fill-rule="evenodd" d="M10.999 5.5V2.75c0-.985-.879-1.5-1.749-1.5c-.888 0-1.261.303-1.354.396a.515.515 0 0 0-.014.719a.483.483 0 0 0 .693.013c.012-.008.197-.128.674-.128c.03 0 .75.006.75.5v.306A5 5 0 0 0 9.249 3c-1.313 0-2 .754-2 1.5s.687 1.5 2 1.5c.372 0 .661-.063.895-.149a.5.5 0 0 0 .855-.351M9.25 4c.372 0 .606.038.75.074v.737c-.093.074-.303.189-.75.189c-.649 0-1-.258-1-.5s.351-.5 1-.5" clip-rule="evenodd"/><path d="M5.001 13.074a3 3 0 0 0-.75-.074c-.649 0-1 .258-1 .5s.351.5 1 .5c.447 0 .657-.115.75-.189z"/><path fill-rule="evenodd" d="M12 15v-5a1 1 0 0 0-1-1H2a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1m-7.749-4.75c.87 0 1.749.515 1.749 1.5v2.75a.5.5 0 0 1-.855.351A2.6 2.6 0 0 1 4.25 15c-1.313 0-2-.754-2-1.5s.687-1.5 2-1.5c.302 0 .546.023.75.056v-.306c0-.494-.72-.5-.75-.5c-.463 0-.65.113-.672.127l-.002.001a.483.483 0 0 1-.693-.013a.515.515 0 0 1 .014-.719c.093-.093.466-.396 1.354-.396m4.079 1.361A1.62 1.62 0 0 0 8 12.625c0 .388.117.748.33 1.014c.369.462.98.343 1.209.139a.499.499 0 1 1 .669.742C9.86 14.834 9.442 15 9 15c-.555 0-1.071-.261-1.451-.736A2.63 2.63 0 0 1 7 12.625c0-.614.195-1.196.549-1.639c.684-.852 1.873-.966 2.66-.256a.5.5 0 1 1-.669.742c-.229-.206-.839-.325-1.21.139M14 6c1.103 0 2-1.009 2-2.25s-.897-2.25-2-2.25c-.366 0-.705.119-1 .313V.5a.5.5 0 0 0-1 0v5a.5.5 0 0 0 .5.5c.217 0 .397-.14.466-.334c.303.207.654.334 1.034.334m0-3.5c.552 0 1 .561 1 1.25S14.552 5 14 5s-1-.561-1-1.25s.448-1.25 1-1.25" clip-rule="evenodd"/><path d="M2 4.5C2 3.673 2.673 3 3.5 3h2.002a.5.5 0 0 1 0 1h-2a.5.5 0 0 0-.5.5v1.793l1.146-1.146a.5.5 0 0 1 .707.707l-2 2a.5.5 0 0 1-.708 0l-2-2a.5.5 0 0 1 .707-.707L2 6.293z"/></g>'
  ),
  /* 匹配条件按钮图标（用户提供）：区分大小写 / 正则 / 全词匹配 */
  caseSensitive: svgCond(
    '<path fill="currentColor" fill-rule="evenodd" d="M4.026 3.342c.136-.408.812-.408.948 0l2 6l.004.013l.996 2.988A.5.5 0 0 1 7.5 13a.5.5 0 0 1-.474-.342L6.14 10H2.86l-.886 2.658a.501.501 0 0 1-.948-.317l.996-2.987l.004-.012zM3.194 9h2.612L4.5 5.081zm8.664-2.332c1.307.065 2.085.816 2.139 2.028l.003.137v3.675a.5.5 0 0 1-.432.487L13.5 13a.5.5 0 0 1-.495-.432L13 12.5v-.07c-.66.377-1.268.57-1.833.57C9.94 13 9 12.137 9 10.833c0-1.15.792-2.004 2.106-2.163A5 5 0 0 1 13 8.81c-.008-.738-.371-1.103-1.19-1.144c-.642-.032-1.093.058-1.357.243a.5.5 0 1 1-.574-.818c.438-.308 1.036-.444 1.789-.43zm.938 3.147a4 4 0 0 0-1.57-.128c-.822.1-1.227.537-1.227 1.17c0 .731.475 1.167 1.167 1.167c.454 0 1.012-.21 1.668-.642l.165-.112V9.876z" clip-rule="evenodd"/>'
  ),
  regexp: svgCond(
    '<path fill="currentColor" d="M11.498 5H9.705l1.268-1.268a.5.5 0 0 0-.707-.707L8.998 4.293V2.5a.5.5 0 0 0-1 0v1.793L6.73 3.025a.5.5 0 0 0-.707.707L7.291 5H5.498a.5.5 0 0 0 0 1h1.793L6.023 7.268a.5.5 0 0 0 .708.707l1.268-1.268V8.5a.5.5 0 0 0 1 0V6.707l1.268 1.268a.5.5 0 0 0 .708 0a.5.5 0 0 0 0-.707L9.707 6H11.5a.5.5 0 0 0 0-1zM5 12a1 1 0 1 1-2 0a1 1 0 0 1 2 0"/>'
  ),
  wholeWord: svgCond(
    '<g fill="currentColor"><path d="M15.5 12.5a.5.5 0 0 1 .5.5v.5c0 .827-.673 1.5-1.5 1.5h-13C.673 15 0 14.327 0 13.5V13a.5.5 0 0 1 1 0v.5a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5V13a.5.5 0 0 1 .5-.5"/><path fill-rule="evenodd" d="M4.858 5.67c1.307.066 2.085.817 2.14 2.03L7 7.835v3.675a.5.5 0 0 1-.432.487l-.068.005a.5.5 0 0 1-.495-.432L6 11.503v-.07c-.659.377-1.268.57-1.833.57C2.941 12.003 2 11.14 2 9.836c0-1.15.792-2.004 2.106-2.163A5 5 0 0 1 6 7.813c-.007-.738-.371-1.103-1.191-1.144c-.641-.032-1.092.058-1.356.243a.5.5 0 1 1-.574-.818c.439-.308 1.036-.444 1.789-.43zm.939 3.148a4 4 0 0 0-1.571-.128c-.822.1-1.227.537-1.227 1.17c0 .731.475 1.167 1.167 1.167c.454 0 1.012-.21 1.668-.642l.165-.112V8.879zM9.55 2.006a.5.5 0 0 1 .45.497v4.1c.418-.377.937-.6 1.5-.6c1.381 0 2.5 1.343 2.5 3s-1.119 3-2.5 3c-.563 0-1.082-.223-1.5-.6v.1a.5.5 0 0 1-.45.497q-.024.004-.05.003a.5.5 0 0 1-.5-.5v-9q0-.026.003-.05a.5.5 0 0 1 .548-.447m1.885 4.998c-.404.028-.858.311-1.145.818a2.44 2.44 0 0 0-.288 1.073q-.003.053-.002.107l.002.107c.016.4.12.767.287 1.07c.287.508.742.794 1.146.821a1 1 0 0 0 .13 0c.404-.027.859-.312 1.146-.82c.167-.304.271-.672.287-1.07q.003-.054.002-.108l-.002-.107a2.44 2.44 0 0 0-.288-1.073c-.287-.507-.74-.79-1.146-.818q-.03-.003-.064-.002q-.033 0-.065.002" clip-rule="evenodd"/></g>'
  ),
  /* 切换当前项来源按钮图标（与 replaceAll 同尺寸：15px / 16×16 viewBox）：
   圆角矩形，左半实心、右半描边，中间竖线穿过 */
  source: svgFill(
    '<g>' +
    // 左半实心：外边界 x1.5→7，y3→13，圆角 2
    '<path d="M3.5 3H7v10H3.5A2 2 0 0 1 1.5 11V5a2 2 0 0 1 2-2Z"/>' +
    // 右半描边：中心线 x10→14，y3.5→12.5；外边界 x9.5→14.5 / y3→13，与左半关于 x=8 对称
    '<path d="M10 3.5H12.5A1.5 1.5 0 0 1 14 5v6a1.5 1.5 0 0 1-1.5 1.5H10" ' +
    'fill="none" stroke="currentColor" stroke-width="1" ' +
    'stroke-linecap="round" stroke-linejoin="round"/>' +
    // 中间竖线：x=8，纵向 1→15 穿过矩形
    '<path d="M8 1v14" fill="none" stroke="currentColor" stroke-width="1" ' +
    'stroke-linecap="round"/>' +
    '</g>'
  ),
};

/* ------------------------------------------------------------------
 *  模块状态
 * ------------------------------------------------------------------ */

/** 编辑器视图注册（codemirrorSetup 创建/销毁时调用） */
let view: EditorView | null = null;
export function registerSearchView(v: EditorView | null): void {
  view = v;
  if (panelEl && open) {
    syncQueryToEditor();
    updateStatusDisplay();
  }
}
export function unregisterSearchView(): void {
  view = null;
}

/** 匹配条件（区分大小写 / 正则 / 全词）全局状态：跨开关保留 */
let globalCaseSensitive = false;
let globalRegexp = false;
let globalWholeWord = false;

let panelEl: HTMLDivElement | null = null;
let open = false;
let source: SearchSource = "editor";

/** 面板需要的 App 侧模式切换（保留预览滚动位置的那份 setMode） */
let modeSwitch: ((m: Mode) => void) | null = null;
export function setPanelModeSwitch(fn: (m: Mode) => void): void {
  modeSwitch = fn;
}

/* 编辑区匹配统计（仅展示用；导航由 CM6 管线驱动） */
let editorStats: { n: number; cur: number; overflow: boolean; bad: boolean } = {
  n: 0, cur: 0, overflow: false, bad: false,
};
/* 预览区匹配列表与当前项（与编辑区完全独立） */
let previewInfo: PreviewMatchInfo | null = null;
let previewCur = 0;
/* 面板正则安全校验结论（null = 通过；非 null = 当前输入被拦截） */
let regexUnsafe: RegexSafetyIssue | null = null;

/* ---- 面板内部 DOM 引用 ---- */
let findInput!: HTMLInputElement;
let replaceInput!: HTMLInputElement;
let caseBtn!: HTMLButtonElement;
let regexBtn!: HTMLButtonElement;
let wordBtn!: HTMLButtonElement;
let statusEl!: HTMLDivElement;
let noteEl!: HTMLDivElement;
let curEl!: HTMLDivElement;
let totalEl!: HTMLDivElement;
let sepEl!: HTMLDivElement;
let replaceBar!: HTMLDivElement;
let replaceOneBtn!: HTMLButtonElement;
let replaceAllBtn!: HTMLButtonElement;
let prevBtn!: HTMLButtonElement;
let nextBtn!: HTMLButtonElement;
let closeBtn!: HTMLButtonElement;
let srcBtn!: HTMLButtonElement;

/** 取界面文案（svelte-i18n；面板为脱离组件树的 DOM，直接读 store 快照） */
const ph = (key: string): string => {
  try {
    return get(t)(key) ?? key;
  } catch {
    return key;
  }
};

/* ------------------------------------------------------------------
 *  打开 / 关闭 / 来源
 * ------------------------------------------------------------------ */

/** 从 window 选区取预览区单行选区文本（供全局 Ctrl+F 拉取），否则 null */
export function getPreviewSelectionText(): string | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const node = range.commonAncestorContainer;
  const elx =
    node.nodeType === Node.ELEMENT_NODE
      ? (node as Element)
      : node.parentElement;
  if (!elx || !elx.closest(".pane-preview")) return null;
  // 排除预览区内的可编辑控件，避免误取输入框选区
  if (elx.closest("input, textarea")) return null;
  const text = sel.toString();
  if (!text || text.includes("\n")) return null;
  return text;
}

/** 当前布局模式下面板默认可用的来源 */
function availableSource(m: Mode): SearchSource {
  return m === "preview" ? "preview" : "editor";
}

/**
 * 全局入口（CM6 内外通用）：
 * - 面板未开 → 按布局模式确定来源后打开；pull（预览区单行选区）非空则填入；
 * - 面板已开 → pull 非空则填入，否则仅聚焦。
 */
export function openSearchPanelFloating(opts?: { pull?: string | null }): void {
  if (!open) {
    source = availableSource(get(mode$));
    buildPanel();
    openPanel();
  }
  const pull = opts?.pull ?? null;
  if (pull) {
    findInput.value = pull;
    applyQuery();
  }
  updateStatusDisplay();
  findInput.focus();
  findInput.select();
}

export function closeSearchPanelFloating(): void {
  if (!open) return;
  open = false;
  if (panelEl) panelEl.style.display = "none";
  document.body.classList.remove("search-open");
  document.body.style.removeProperty("--search-panel-h");
  resetPreviewSearchState();
  searchPanelOpen$.set(false);
  if (view) closeSearchPanel(view);
}

export function isSearchPanelOpen(): boolean {
  return open;
}

/**
 * 面板打开时编辑区需要让出的顶部余量（供 EditorView.scrollMargins 读值）。
 * 面板未开返回 0。facet 回调在测量期执行，读 DOM 高度安全。
 */
export function getPanelTopMargin(): number {
  if (!open || !panelEl) return 0;
  return panelEl.offsetHeight + PANEL_GAP;
}

function openPanel(): void {
  open = true;
  panelEl!.style.display = "flex";
  document.body.classList.add("search-open");
  document.body.style.setProperty("--search-panel-h", `${getPanelTopMargin()}px`);
  searchPanelOpen$.set(true);
  if (view) openSearchPanel(view);   // ← 让 searchState.panel 变为非空
  syncQueryToEditor();
  applySourceUI();
  applyI18n();
  syncCaseBtnState();
  refreshAll();
  if (source === "preview" && previewInfo && previewInfo.total > 0) {
    // 初始当前项：取预览视口顶段（topIndex$）之后的第一处匹配，避免跳走
    const top = get(topIndex$);
    const idx = previewInfo.segOf.findIndex((s) => s >= top);
    previewCur = idx >= 0 ? idx : 0;
    pushPreviewState();
  }
}

/** 切换当前项来源；目标来源在当前布局不可用时先切到双栏 */
function toggleSource(): void {
  const target: SearchSource = source === "editor" ? "preview" : "editor";
  const m = get(mode$);
  if ((target === "editor" && m === "preview") || (target === "preview" && m === "source")) {
    // 目标来源在当前布局模式不可用：切双栏（预览滚动位置由 App.setMode 保留）
    modeSwitch?.("split");
  }
  source = target;
  previewCur = 0;
  applySourceUI();
  refreshAll();
  if (source === "preview" && previewInfo && previewInfo.total > 0) {
    scrollToPreviewMatch(previewCur);
  }
  findInput.focus();
}

/* ------------------------------------------------------------------
 *  查询应用与统计
 * ------------------------------------------------------------------ */

function buildQuery(): SearchQuery {
  return new SearchQuery({
    search: findInput.value,
    replace: replaceInput.value,
    caseSensitive: globalCaseSensitive,
    regexp: globalRegexp,
    wholeWord: globalWholeWord,
  });
}

/** 把当前查询同步给编辑区（无论来源——保证切回编辑区时高亮即时可用） */
function syncQueryToEditor(): void {
  if (!view) return;
  try {
    // 不安全正则：向编辑区同步空查询，停用 CM6 搜索管线（防 getCursor 回溯失控）
    view.dispatch({
      effects: setSearchQuery.of(
        regexUnsafe ? new SearchQuery({ search: "" }) : buildQuery()
      ),
    });
  } catch {
    /* 编辑器可能尚未就绪 */
  }
}

/** 重算面板正则安全校验结论（仅正则模式有意义） */
function updateRegexSafety(): void {
  regexUnsafe = checkRegexSafety({
    search: findInput.value,
    caseSensitive: globalCaseSensitive,
    regexp: globalRegexp,
    wholeWord: globalWholeWord,
  });
}

/** 查找条件/关键词变化：同步编辑区管线 + 刷新统计与装饰 */
function applyQuery(): void {
  updateRegexSafety();
  syncQueryToEditor();
  refreshAll();
}

/** 全量刷新：编辑区统计、预览区匹配列表、状态文本、装饰状态 */
function refreshAll(): void {
  updateRegexSafety();
  updateEditorStats();
  updatePreviewMatches();
  updateStatusDisplay();
  pushPreviewState();
}

function updateEditorStats(): void {
  editorStats = { n: 0, cur: 0, overflow: false, bad: false };
  if (!view) return;
  const q = buildQuery();
  if (!q.search) return;
  // 安全校验拦截（双方生效）：编辑区统计直接标记为无效正则，不再执行 getCursor
  if (regexUnsafe) {
    editorStats.bad = true;
    return;
  }
  const upto = view.state.selection.main.to;
  try {
    const cursor = q.getCursor(view.state.doc);
    for (; ;) {
      const r = cursor.next();
      if (r.done) break;
      editorStats.n++;
      if (r.value.to <= upto) editorStats.cur = editorStats.n;
      if (editorStats.n > MATCH_CAP) {
        editorStats.overflow = true;
        editorStats.n = MATCH_CAP;
        break;
      }
    }
  } catch {
    editorStats.bad = true;
  }
}

function updatePreviewMatches(): void {
  // 匹配列表恒计算（与当前项来源无关）：装饰器不依赖来源，来源只决定当前项在哪边
  const { re, bad, unsafe } = buildPreviewPattern({
    search: findInput.value,
    caseSensitive: globalCaseSensitive,
    regexp: globalRegexp,
    wholeWord: globalWholeWord,
  });
  const info = bad || unsafe || !re ? null : computePreviewMatches(get(segments$), re);
  previewInfo = info;
  if (info) {
    previewCur = Math.max(0, Math.min(previewCur, info.total - 1));
  } else {
    previewCur = 0;
  }
}

/** 跨行结果提示文本：无结果/异常时单行居中，有匹配项时两行 + 分隔线 */
function updateStatusDisplay(): void {
  const q = findInput.value;
  if (!q) {
    setStatusNote(ph("search.noResults"));
    return;
  }
  // 正则安全校验拦截（双方生效）：优先于两侧来源的常规状态显示
  if (regexUnsafe) {
    setStatusNote(
      ph(regexUnsafe === "redos" ? "search.unsafeRegex" : "search.zeroWidthRegex")
    );
    return;
  }
  if (source === "editor") {
    if (editorStats.bad) {
      setStatusNote(ph("search.badRegex"));
      return;
    }
    if (editorStats.n === 0) {
      setStatusNote(ph("search.noResults"));
      return;
    }
    if (editorStats.overflow) {
      setStatusNote(ph("search.overflow"));
      return;
    }
    setStatusCounts(String(editorStats.cur), String(editorStats.n));
    return;
  }
  // 预览区来源
  if (!previewInfo || previewInfo.total === 0) {
    setStatusNote(ph("search.noResults"));
    return;
  }
  if (previewInfo.overflow) {
    setStatusNote(ph("search.overflow"));
    return;
  }
  setStatusCounts(String(previewCur + 1), String(previewInfo.total));
}

function setStatusNote(text: string): void {
  statusEl.classList.remove("has-matches");
  noteEl.textContent = text;
}

function setStatusCounts(cur: string, total: string): void {
  statusEl.classList.add("has-matches");
  curEl.textContent = cur;
  totalEl.textContent = total;
  noteEl.textContent = "";
}

/** 预览装饰状态下发（面板驱动；MarkdownSegment 派生消费） */
function pushPreviewState(): void {
  // 装饰器生效条件与当前项来源无关：面板打开且预览区有匹配即下发
  if (!open || !previewInfo || previewInfo.total === 0) {
    resetPreviewSearchState();
    return;
  }
  const { re } = buildPreviewPattern({
    search: findInput.value,
    caseSensitive: globalCaseSensitive,
    regexp: globalRegexp,
    wholeWord: globalWholeWord,
  });
  if (!re) {
    resetPreviewSearchState();
    return;
  }
  setPreviewSearchState({
    active: true,
    re,
    // 来源只决定当前项在哪边：来源=编辑区时预览区不标当前项（-1）
    current: source === "preview" ? previewCur : -1,
    info: previewInfo,
  });
}

/* ------------------------------------------------------------------
 *  导航（编辑区走 CM6 管线；预览区自行实现滚动）
 * ------------------------------------------------------------------ */

function gotoMatch(delta: number): void {
  if (source === "editor") {
    if (!view || !findInput.value) return;
    if (delta > 0) findNext(view);
    else findPrevious(view);
    updateEditorStats();
    updateStatusDisplay();
    return;
  }
  const info = previewInfo;
  if (!info || info.total === 0) return;
  previewCur = (previewCur + delta + info.total) % info.total;
  updateStatusDisplay();
  pushPreviewState();
  scrollToPreviewMatch(previewCur);
}

/** 把第 id 项匹配滚动到预览视口内（未挂载段先跳块，挂载后按 mark 精调） */
function scrollToPreviewMatch(id: number): void {
  const info = previewInfo;
  if (!info) return;
  const seg = info.segOf[id];
  const sc = document.querySelector<HTMLElement>(".preview-scroll");
  if (!sc) return;
  const margin = (panelEl?.offsetHeight ?? 0) + PANEL_GAP;
  const adjust = (mark: HTMLElement | null): boolean => {
    if (!mark) return false;
    const scRect = sc.getBoundingClientRect();
    const mRect = mark.getBoundingClientRect();
    if (mRect.top < scRect.top + margin || mRect.bottom > scRect.bottom) {
      sc.scrollTop += mRect.top - (scRect.top + margin);
    }
    return true;
  };
  const findMark = (): HTMLElement | null =>
    sc.querySelector<HTMLElement>(
      `.md-item[data-index="${seg}"] mark.pv-search-hl[data-mid="${id}"]`,
    );

  let mark = findMark();
  if (mark && adjust(mark)) return;
  // 段未挂载（虚拟滚动）：先对齐段顶，随后等 mark 渲染完成再精调
  try {
    get(previewApi$)?.scrollToIndex(seg, { offset: 0 });
  } catch {
    /* 预览可能未挂载 */
  }
  let frames = 0;
  const tick = (): void => {
    mark = findMark();
    if (mark) {
      adjust(mark);
      return;
    }
    if (++frames < 60) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/* ------------------------------------------------------------------
 *  CM6 编辑器联动入口（codemirrorSetup 调用）
 * ------------------------------------------------------------------ */

/** 编辑器事务后刷新（docChanged / selectionSet；仅来源=编辑区时开销） */
export function notifyEditorUpdate(_u: ViewUpdate): void {
  if (!open || source !== "editor") return;
  updateEditorStats();
  updateStatusDisplay();
}

/**
 * 编辑区 Mod-f：面板已开 → 拉取编辑器选区到关键词框；未开 → 打开面板。
 * 恒返回 true（必须排在 searchKeymap 之前，吞掉 CM 原生面板入口）。
 */
export function handleEditorModF(): boolean {
  const sel = view?.state.selection.main;
  const text =
    sel && !sel.empty && view
      ? view.state.doc.sliceString(sel.from, sel.to)
      : "";
  openSearchPanelFloating({ pull: text && !text.includes("\n") ? text : null });
  return true;
}

/* ------------------------------------------------------------------
 *  面板 DOM 构建
 * ------------------------------------------------------------------ */

function buildPanel(): void {
  if (panelEl) return;

  panelEl = el("div", "sp-float");
  panelEl.setAttribute("role", "search");
  panelEl.style.display = "none";

  /* ---- 块 1：查找栏 / 替换栏 ---- */
  const inputs = el("div", "sp-inputs");

  const findBar = el("div", "sp-bar");
  findInput = el("input", "sp-input");
  findInput.type = "text";
  findInput.spellcheck = false;
  const conds = el("div", "sp-conds");
  caseBtn = el("button", "sp-cond", "");
  caseBtn.type = "button";
  caseBtn.innerHTML = ICONS.caseSensitive;
  regexBtn = el("button", "sp-cond", "");
  regexBtn.type = "button";
  regexBtn.innerHTML = ICONS.regexp;
  wordBtn = el("button", "sp-cond", "");
  wordBtn.type = "button";
  wordBtn.innerHTML = ICONS.wholeWord;
  conds.append(caseBtn, regexBtn, wordBtn);
  findBar.append(findInput, conds);

  replaceBar = el("div", "sp-bar sp-replace-bar");
  replaceInput = el("input", "sp-input");
  replaceInput.type = "text";
  replaceInput.spellcheck = false;
  replaceBar.append(replaceInput);

  inputs.append(findBar, replaceBar);

  /* ---- 块 2：跨行结果提示文本 ---- */
  statusEl = el("div", "sp-status");
  curEl = el("div", "sp-cur");
  sepEl = el("div", "sp-sep");
  totalEl = el("div", "sp-total");
  noteEl = el("div", "sp-note");
  statusEl.append(curEl, sepEl, totalEl, noteEl);

  /* ---- 块 3：两份按钮组 ---- */
  const nav = el("div", "sp-nav");
  const navGroup = el("div", "sp-group");
  prevBtn = el("button", "sp-btn");
  prevBtn.type = "button";
  prevBtn.innerHTML = ICONS.up;
  nextBtn = el("button", "sp-btn");
  nextBtn.type = "button";
  nextBtn.innerHTML = ICONS.down;
  navGroup.append(prevBtn, nextBtn);

  const repGroup = el("div", "sp-group");
  replaceOneBtn = el("button", "sp-btn");
  replaceOneBtn.type = "button";
  replaceOneBtn.innerHTML = ICONS.replaceOne;
  replaceAllBtn = el("button", "sp-btn");
  replaceAllBtn.type = "button";
  replaceAllBtn.innerHTML = ICONS.replaceAll;
  repGroup.append(replaceOneBtn, replaceAllBtn);
  nav.append(navGroup, repGroup);

  /* ---- 块 4：两枚独立按钮 ---- */
  const ends = el("div", "sp-ends");
  closeBtn = el("button", "sp-close");
  closeBtn.type = "button";
  closeBtn.innerHTML = ICONS.close;
  srcBtn = el("button", "sp-src");
  srcBtn.type = "button";
  srcBtn.innerHTML = ICONS.source;
  ends.append(closeBtn, srcBtn);

  panelEl.append(inputs, statusEl, nav, ends);
  const app = document.querySelector('#app-root') as Element;
  app.appendChild(panelEl);

  /* ---- 行为 ---- */
  findInput.addEventListener("input", applyQuery);
  findInput.addEventListener("keydown", (e) => {
    if (get(confirm$) || get(dialogMask$)) return;
    if (e.key === "Enter") {
      e.preventDefault();
      gotoMatch(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeSearchPanelFloating();
    }
  });
  replaceInput.addEventListener("input", () => {
    syncQueryToEditor();
  });
  replaceInput.addEventListener("keydown", (e) => {
    if (get(confirm$) || get(dialogMask$)) return;
    if (e.key === "Enter") {
      e.preventDefault();
      if (source === "editor" && view) replaceNext(view);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeSearchPanelFloating();
    }
  });

  caseBtn.addEventListener("click", () => {
    globalCaseSensitive = !globalCaseSensitive;
    syncCaseBtnState();
    applyQuery();
  });
  regexBtn.addEventListener("click", () => {
    globalRegexp = !globalRegexp;
    syncCaseBtnState();
    applyQuery();
  });
  wordBtn.addEventListener("click", () => {
    globalWholeWord = !globalWholeWord;
    syncCaseBtnState();
    applyQuery();
  });

  prevBtn.addEventListener("click", () => gotoMatch(-1));
  nextBtn.addEventListener("click", () => gotoMatch(1));
  replaceOneBtn.addEventListener("click", () => {
    if (source !== "editor" || !view) return;
    replaceNext(view);
  });
  replaceAllBtn.addEventListener("click", () => {
    if (source !== "editor" || !view) return;
    replaceAll(view);
  });
  closeBtn.addEventListener("click", closeSearchPanelFloating);
  srcBtn.addEventListener("click", toggleSource);
}

function syncCaseBtnState(): void {
  caseBtn.classList.toggle("on", globalCaseSensitive);
  regexBtn.classList.toggle("on", globalRegexp);
  wordBtn.classList.toggle("on", globalWholeWord);
}

/** 来源变化后的 UI 联动 */
function applySourceUI(): void {
  const preview = source === "preview";
  findInput.placeholder = preview ? ph("search.findInPreview") : ph("search.findInEditor");
  replaceInput.disabled = preview;
  replaceBar.classList.toggle("sp-disabled", preview);
  replaceOneBtn.disabled = preview;
  replaceAllBtn.disabled = preview;
  // 激活状态为编辑区（而非图标 title 描述的预览区）
  srcBtn.classList.toggle("on", !preview);
  applyI18n();
}

function applyI18n(): void {
  findInput.placeholder = source === "preview" ? ph("search.findInPreview") : ph("search.findInEditor");
  caseBtn.title = ph("search.matchCase");
  regexBtn.title = ph("search.regexp");
  wordBtn.title = ph("search.wholeWord");
  prevBtn.title = ph("search.prev");
  nextBtn.title = ph("search.next");
  closeBtn.title = ph("search.close");
  replaceInput.placeholder = ph("search.replace");
  replaceOneBtn.title = ph("search.replaceOne");
  replaceAllBtn.title = ph("search.replaceAll");
  srcBtn.title = ph("search.switchSource");
  updateStatusDisplay();
}

/* 语言切换：面板常驻 body 之外组件树，订阅 locale 重刷文案 */
locale.subscribe(() => {
  if (panelEl && open) applyI18n();
});

/* 段列表更新（解析增量落地）：重算匹配列表（装饰器不依赖当前项来源） */
segments$.subscribe(() => {
  if (panelEl && open) {
    updatePreviewMatches();
    updateStatusDisplay();
    pushPreviewState();
  }
});

/* 全局 Escape 关闭（面板内部输入框 / 编辑器 / 预览区 / 空焦点）。
   弹层（设置、确认、菜单）内的 Escape 事件不在此处理，避免双重响应 */
document.addEventListener("keydown", (e) => {
  if (!open || e.key !== "Escape" || e.defaultPrevented || get(confirm$) || get(dialogMask$)) return;
  const t = e.target;
  const inPanel = panelEl !== null && t instanceof Node && panelEl.contains(t);
  const inEditor = t instanceof Element && !!t.closest(".cm-editor");
  const inPreview = t instanceof Element && !!t.closest(".pane-preview");
  if (inPanel || inEditor || inPreview || t === document.body || t == null) {
    e.preventDefault();
    closeSearchPanelFloating();
  }
});
