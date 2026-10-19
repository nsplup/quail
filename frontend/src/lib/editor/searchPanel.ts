/**
 * 自定义「现代风格」查找/替换面板，替代 @codemirror/search 的原生面板。
 * 通过 search({ createPanel }) 注入，仍是 CM6 原生搜索管线（SearchQuery / searchKeymap）。
 *
 * 样式约定（app.css .cm-search-panel）：
 * - 扁平化：无阴影，底部描边与分栏分隔线同为 1px；
 * - 按钮按功能两两分组（组按钮样式）：[替换|全部替换] [Aa|.*] [↑|↓]；
 * - 替换单个 / 全部替换使用可区分的图标；
 * - 计数区默认显示「无结果 / No results」（无论是否有关键词），命中时显示数字。
 */
import {
  SearchQuery,
  setSearchQuery,
  getSearchQuery,
  findNext,
  findPrevious,
  replaceNext,
  replaceAll,
  closeSearchPanel,
  openSearchPanel,
} from "@codemirror/search";
import type { EditorView, Panel } from "@codemirror/view";

/** 面板 DOM 上的扩展钩子 */
interface SearchPanelDom extends HTMLElement {
  /** CM6 内重复 Mod-f：从编辑器选区拉取并聚焦 */
  __spPull?: () => void;
  /** 外部入口：按需填入给定文本后聚焦（null 表示仅聚焦、保留既有查询词） */
  __spActivate?: (text: string | null) => void;
}

/**
 * 全局 Ctrl/F 入口（CM6 以外触发）的挂起状态：
 * - 面板未开 → 打开面板；`pull` 为预览区单行选区文本（或无）。
 * - 面板已开 → 直接 __spActivate，不用此变量。
 * null 表示非外部打开。
 */
let pendingExternal: { pull: string | null } | null = null;

/**
 * 从 window 选区取文本；仅当：
 * - 选区非空；
 * - 选区公共祖先落在 .pane-preview 内；
 * - 文本非空且为单行。
 * 否则返回 null。同步抓取（供 openSearchPanelExternal 在 focus 前调用）。
 */
function getPreviewSelectionText(): string | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const node = range.commonAncestorContainer;
  const el =
  node.nodeType === Node.ELEMENT_NODE
  ? (node as Element)
  : node.parentElement;
  if (!el || !el.closest(".pane-preview")) return null;
  // 排除预览区内的可编辑控件，避免误取输入框选区
  if (el.closest("input, textarea")) return null;
  const text = sel.toString().trim();
  if (!text || text.includes("\n")) return null;
  return text;
}

/**
 * 外部（CM6 以外，全局 Ctrl+F）触发的打开入口：
 * - 面板未开 → 打开面板；若预览区有单行选区则填入关键词框，否则保留既有查询词；
 * - 面板已开 → 同上（预览区有选区则填入，否则仅聚焦）。
 * CM6 内的「重复 Mod-f 拉取编辑器选区」行为（searchPanelModF / __spPull）
 * 不在 CM6 以外的区域触发。
 */
export function openSearchPanelExternal(view: EditorView): void {
  const panel = view.dom.querySelector<SearchPanelDom>(".cm-search-panel");
  const pull = getPreviewSelectionText();
  if (panel?.__spActivate) {
    panel.__spActivate(pull);
    return;
  }
  pendingExternal = { pull };
  openSearchPanel(view);
}

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
};

/**
 * Mod-f 拦截：面板已开 → 从编辑器选区拉取内容填入关键词框（并聚焦选中）；
 * 面板未开 → 返回 false 落回 searchKeymap 的 openSearchPanel 正常打开。
 * 需排在 ...searchKeymap 之前。
 */
export function searchPanelModF(view: EditorView): boolean {
  const dom = view.dom.querySelector<SearchPanelDom>(".cm-search-panel");
  if (dom?.__spPull) {
    dom.__spPull();
    return true;
  }
  return false;
}

/* 匹配条件（区分大小写 / 正则）全局状态：跨面板实例保留，
 *  不随面板关闭重开或语言切换（phrases 重配）而重置 */
let globalCaseSensitive = false;
let globalRegexp = false;

export function createModernSearchPanel(view: EditorView): Panel {
  const dom = el("div", "cm-search-panel");

  /* ---- 第一行：查找输入 + 计数 + 上下导航 + 关闭 ---- */
  const row1 = el("div", "sp-row flex items-center gap-1.5");
  const input = el("input", "sp-input sp-find") as HTMLInputElement;
  input.type = "text";
  input.spellcheck = false;

  const count = el("span", "sp-count");

  const navGroup = el("div", "sp-group");
  const prevBtn = el("button", "sp-btn");
  prevBtn.type = "button";
  prevBtn.innerHTML = ICONS.up;
  const nextBtn = el("button", "sp-btn");
  nextBtn.type = "button";
  nextBtn.innerHTML = ICONS.down;
  navGroup.append(prevBtn, nextBtn);

  const closeBtn = el("button", "sp-btn sp-close");
  closeBtn.type = "button";
  closeBtn.innerHTML = ICONS.close;

  row1.append(input, count, navGroup, closeBtn);

  /* ---- 第二行：替换输入 + 替换按钮组 + 匹配条件按钮组 ---- */
  const row2 = el("div", "sp-row flex items-center gap-1.5");
  const replaceInput = el("input", "sp-input sp-replace") as HTMLInputElement;
  replaceInput.type = "text";
  replaceInput.spellcheck = false;

  const replaceGroup = el("div", "sp-group");
  const replaceOneBtn = el("button", "sp-btn");
  replaceOneBtn.type = "button";
  replaceOneBtn.innerHTML = ICONS.replaceOne;

  const replaceAllBtn = el("button", "sp-btn");
  replaceAllBtn.type = "button";
  replaceAllBtn.innerHTML = ICONS.replaceAll;
  replaceGroup.append(replaceOneBtn, replaceAllBtn);

  const matchGroup = el("div", "sp-group");
  const caseBtn = el("button", "sp-btn sp-toggle text-[11px] font-semibold", "Aa");
  caseBtn.type = "button";
  const regexBtn = el("button", "sp-btn sp-toggle text-[11px] font-semibold", ".*");
  regexBtn.type = "button";
  matchGroup.append(caseBtn, regexBtn);

  /* 与第一行关闭按钮等宽的占位（grid 第 4 列），保证上下两个输入框齐宽 */
  const row2Tail = el("div", "sp-tail");
  row2.append(replaceInput, replaceGroup, matchGroup, row2Tail);

  /* ---- 文案：经 CM6 phrases（EditorState.phrases 由 i18n-messages 的 cmPhrases 注入，
   *        语言切换时 reconfigure 后本函数在 update 中重跑即生效） ---- */
  const ph = (s: string): string => view.state.phrase(s) ?? s;

  let caseSensitive = globalCaseSensitive;
  let regexp = globalRegexp;

  const applyI18n = (): void => {
    input.placeholder = ph("Find");
    caseBtn.title = ph("Match case");
    regexBtn.title = ph("Regular expression");
    prevBtn.title = ph("Previous (Shift+Enter)");
    nextBtn.title = ph("Next (Enter)");
    closeBtn.title = ph("Close (Esc)");
    replaceInput.placeholder = ph("Replace");
    replaceOneBtn.title = ph("Replace");
    replaceAllBtn.title = ph("Replace all");
  };
  applyI18n();

  /* ---- 行为 ---- */
  const buildQuery = () =>
  new SearchQuery({
    search: input.value,
    replace: replaceInput.value,
    caseSensitive,
    regexp,
  });

  function updateCount(): void {
    const q = getSearchQuery(view.state);
    if (!q || !q.search) {
      // 无关键词也默认显示「无结果」，而非留空/横杠
      count.textContent = ph("No results");
      return;
    }
    let n = 0;
    let current = 0;
    const upto = view.state.selection.main.to;
    try {
      const cursor = q.getCursor(view.state.doc);
      for (;;) {
        const r = cursor.next();
        if (r.done) break;
        n++;
        if (r.value.to <= upto) current = n;
        if (n > 999) {
          count.textContent = ph("999+");
          return;
        }
      }
    } catch {
      count.textContent = ph("Bad regex");
      return;
    }
    count.textContent = n === 0 ? ph("No results") : `${current}/${n}`;
  }

  function applyQuery(): void {
    view.dispatch({ effects: setSearchQuery.of(buildQuery()) });
    updateCount();
  }

  input.addEventListener("input", applyQuery);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) findPrevious(view);
      else findNext(view);
    } else if (e.key === "Escape") {
      closeSearchPanel(view);
    }
  });

  replaceInput.addEventListener("input", applyQuery);
  replaceInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      replaceNext(view);
    } else if (e.key === "Escape") {
      closeSearchPanel(view);
    }
  });

  caseBtn.addEventListener("click", () => {
    caseSensitive = !caseSensitive;
    globalCaseSensitive = caseSensitive;
    caseBtn.classList.toggle("on", caseSensitive);
    applyQuery();
  });
  regexBtn.addEventListener("click", () => {
    regexp = !regexp;
    globalRegexp = regexp;
    regexBtn.classList.toggle("on", regexp);
    applyQuery();
  });
  prevBtn.addEventListener("click", () => findPrevious(view));
  nextBtn.addEventListener("click", () => findNext(view));
  replaceOneBtn.addEventListener("click", () => replaceNext(view));
  replaceAllBtn.addEventListener("click", () => replaceAll(view));
  closeBtn.addEventListener("click", () => closeSearchPanel(view));

  dom.append(row1, row2);

  return {
    dom,
    top: true,
    mount() {
      const d = dom as SearchPanelDom;
      const focusInput = (): void => {
        input.focus();
        input.select();
      };

      // 面板已开时再次按 Ctrl+F（CM6 内）：从当前编辑器选区拉取内容同步给关键词输入框。
      // 在键盘事件回调里执行，同步 dispatch 合法。
      d.__spPull = () => {
        const sel = view.state.selection.main;
        const text = sel.empty ? "" : view.state.doc.sliceString(sel.from, sel.to);
        if (text) {
          input.value = text;
          applyQuery();
        }
        focusInput();
      };

      // 外部入口（全局 Ctrl+F 等）已开兜底：预览区有选区则填入，否则仅聚焦。
      // pull 已由 openSearchPanelExternal 同步取好（此时 window 选区尚未被 focus 清掉）。
      d.__spActivate = (text) => {
        if (text) {
          input.value = text;
          applyQuery();
        }
        focusInput();
      };

      caseBtn.classList.toggle("on", globalCaseSensitive);
      regexBtn.classList.toggle("on", globalRegexp);
      applyI18n();

      // 打开时带入搜索词：
      // - 外部打开：预览区单行选区优先，否则保留既有查询词；
      // - 内部打开：既有查询词优先，否则用编辑器单行选区。
      // 注意：mount 处于 CM 更新流程内，禁止同步 dispatch（会中断面板 DOM 插入），
      // 因此 query 的写入延后到微任务。
      const ext = pendingExternal;
      pendingExternal = null;
      const sel = view.state.selection.main;
      const selText = sel.empty ? "" : view.state.doc.sliceString(sel.from, sel.to);
      const existing = getSearchQuery(view.state)?.search ?? "";
      const initial = ext
      ? ext.pull ?? existing
      : existing || (selText && !selText.includes("\n") ? selText : "");
      if (initial) {
        input.value = initial;
        queueMicrotask(() => {
          try {
            view.dispatch({ effects: setSearchQuery.of(buildQuery()) });
            updateCount();
          } catch { /* 面板可能已关闭 */ }
        });
      }
      updateCount();
      input.focus();
      input.select();
    },
    update(u) {
      caseBtn.classList.toggle("on", globalCaseSensitive);
      regexBtn.classList.toggle("on", globalRegexp);
      applyI18n();
      if (u.docChanged || u.selectionSet) updateCount();
    },
    destroy() {
      /* noop */
    },
  };
}
