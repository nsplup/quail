/**
 * CodeMirror 6 最小构建：
 * 不使用 `codemirror` 聚合包，只按需引入 state/view/commands/search/language，
 * Markdown 语法高亮由 @codemirror/lang-markdown（lezer）提供。
 *
 * 主题通过 CSS 变量注入（--ed-*，由 themes.css 的主题类提供），因此
 * 切换预览主题时编辑器配色同步变化，无需重新 configure。
 */
import { EditorState, Compartment, type Text } from "@codemirror/state";
import { cmPhrases } from "../i18n-messages";
import {
  EditorView,
  keymap,
  crosshairCursor,
  highlightSpecialChars,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  undo,
  redo,
  indentMore,
  indentLess,
} from "@codemirror/commands";
import { search, searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxHighlighting, HighlightStyle, bracketMatching, indentUnit } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import type { Command } from "@codemirror/view";
import { createModernSearchPanel, searchPanelModF } from "./searchPanel";
import { dirty$ } from "../stores";

export interface EditorHandlers {
  /** 文档内容变化（编辑器是源码的唯一编辑入口） */
  onchange: (doc: string) => void;
  /** Ctrl/Cmd+S 保存（始终保存源码） */
  onsave: () => void;
  /** 编辑器滚动：视口顶部对应源码行号（用于 编辑器→预览 同步） */
  ontopline: (line: number) => void;
}

export interface EditorApi {
  destroy(): void;
  /** 滚动到源码某行（用于 预览→编辑器 / 大纲 同步） */
  scrollToLine(line: number): void;
  /** 当前视口顶行（内容/块偏移变化后的滚动重对齐用） */
  getTopLine(): number;
  /** 滚动到「小数行号」位置（块内插值同步，支持 1.5 这类行号） */
  scrollToFractionalLine(fline: number): void;
  /** 滚动到文档最底部（预览到底时的同步目标） */
  scrollToBottom(): void;
  getDoc(): string;
  /** 整体替换文档内容（后端 file:changed 外部修改事件） */
  setDoc(text: string): void;
  /** 隐藏后重新显示时请求重新测量几何信息 */
  measure(): void;
  /** 切换缩进单位（设置里选择制表符 / 空格），动态重配置无需重建编辑器 */
  setIndentUnit(unit: string): void;
  /** 切换界面语言后重配 CM6 phrases（查找面板文案随语言更新） */
  setPhrases(lang: string): void;
  /** 字号变化后请求重新测量布局（CSS 变量变化不会自动触发 CM 测量） */
  requestMeasure(): void;
  /** 记录干净文档引用（初始化/保存成功后调用） */
  markClean(): void;
}

/* Tab 键行为：
 * - 无选区：在光标处插入缩进单位（制表符或空格，由设置决定）；
 * - 有选区：整体缩进选中行（indentMore，Shift+Tab 反向 indentLess）。 */
function tabCommand(getUnit: () => string): Command {
  return (view) => {
    const { state } = view;
    if (state.selection.ranges.some((r) => !r.empty)) {
      return indentMore(view);
    }
    view.dispatch(state.replaceSelection(getUnit()), {
      scrollIntoView: true,
    });
    return true;
  };
}

/* ---------------- 主题（CSS 变量驱动，静态配置一次） ---------------- */

const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "var(--ed-bg)",
    color: "var(--ed-fg)",
    /* 字体/字号由主题脚本注入的变量控制（设置面板可实时调整） */
    fontSize: "var(--ed-font-size, 13.5px)",
  },
  ".cm-scroller": {
    fontFamily: "var(--ed-font-family, ui-monospace, monospace)",
    lineHeight: "1.75",
    padding: "10px 0 45vh",
    overflow: "auto",
  },
  ".cm-content": {
    caretColor: "var(--ed-accent)",
    padding: "0",
  },
  ".cm-line": {
    padding: "0 18px",
  },
  ".cm-cursor": {
    borderLeftColor: "var(--ed-accent)",
    borderLeftWidth: "2px",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "var(--ed-selection)",
  },
  ".cm-selectionMatch": { backgroundColor: "var(--ed-selection)" },
  ".cm-searchMatch": {
    backgroundColor: "var(--ed-search)",
    outline: "1px solid var(--ed-accent)",
    borderRadius: "2px",
  },
  ".cm-activeLine": { backgroundColor: "var(--ed-activeline)" },
  ".cm-panels": {
    backgroundColor: "transparent",
    color: "var(--ed-fg)",
    zIndex: "2",
  },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--ui-border)" },
});

const mdHighlight = HighlightStyle.define([
  { tag: [tags.heading1, tags.heading2, tags.heading3, tags.heading4, tags.heading5, tags.heading6], color: "var(--ed-accent)", fontWeight: "700" },
  { tag: tags.strong, fontWeight: "700", color: "var(--ed-strong)" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through", color: "var(--ed-muted)" },
  { tag: tags.link, color: "var(--ed-link)", textDecoration: "underline" },
  { tag: tags.url, color: "var(--ed-link)" },
  { tag: tags.monospace, color: "var(--ed-code)" },
  { tag: tags.quote, color: "var(--ed-muted)", fontStyle: "italic" },
  { tag: [tags.processingInstruction, tags.meta, tags.punctuation], color: "var(--ed-muted)" },
  { tag: [tags.keyword, tags.atom], color: "var(--ed-accent)" },
  { tag: [tags.string, tags.contentSeparator], color: "var(--ed-string)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--ed-string)" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "var(--ed-muted)", fontStyle: "italic" },
  { tag: tags.invalid, color: "var(--ed-danger)" },
]);

/* ---------------- 创建编辑器 ---------------- */

export function createEditorApi(
  parent: HTMLElement,
  initialDoc: string,
  handlers: EditorHandlers,
  initialIndent: string,
  initialLang = "en"
): EditorApi {
  let topLineRaf = 0;
  let programmaticUntil = 0;

  /* 缩进单位用 Compartment 动态重配置（设置切换 制表符/空格 时生效） */
  const indentCompartment = new Compartment();
  /* 历史独立 Compartment：打开文档时卸载再重装 = 清空撤销历史 */
  const historyCompartment = new Compartment();
  /* 输入停顿多久后合并为新的撤销组（CM6 默认 500ms，收紧为 200ms） */
  const HISTORY_NEW_GROUP_DELAY = 200;
  const phrasesCompartment = new Compartment();
  /* 干净文档引用：初始化或保存后记录 state.doc，用 Text.eq 判定脏状态 */
  let cleanDoc: Text | null = null;
  const phrasesFor = (lang: string) =>
    EditorState.phrases.of(lang === "zh" ? cmPhrases : {});
  let indent = initialIndent;

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: initialDoc,
      extensions: [
        highlightSpecialChars(),
        historyCompartment.of(history({ newGroupDelay: HISTORY_NEW_GROUP_DELAY })),
        crosshairCursor(),
        bracketMatching(),
        highlightSelectionMatches(),
        /* 禁用多光标：false 时状态层把任何新选区 asSingle() 折叠，
         Ctrl/Cmd+Click、矩形拖拽、Ctrl-Alt-↑/↓ 等所有入口一并失效 */
      EditorState.allowMultipleSelections.of(false),
      /* 拖拽永远视为“移动”而非“添加”：Alt/Ctrl+左键拖拽不再产生
         选区/光标扩展（矩形选区扩展已移除，此为兜底） */
      EditorView.dragMovesSelection.of(() => true),
        EditorView.lineWrapping,
        markdown(),
        indentCompartment.of(indentUnit.of(initialIndent)),
        phrasesCompartment.of(phrasesFor(initialLang)),
        editorTheme,
        syntaxHighlighting(mdHighlight),
        search({
          // 用自研面板替代原生查找面板
          createPanel: createModernSearchPanel,
          top: true,
        }),
        keymap.of([
          // 面板已开时 Mod-f 拉取选区到关键词框（须在 searchKeymap 之前拦截）
          { key: "Mod-f", run: searchPanelModF },
          { key: "Mod-s", preventDefault: true, run: () => (handlers.onsave(), true) },
          { key: "Mod-z", run: undo, shift: redo },
          { key: "Mod-y", run: redo },
          { key: "Tab", run: tabCommand(() => indent) },
          { key: "Shift-Tab", run: indentLess },
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            handlers.onchange(u.state.doc.toString());
            if (cleanDoc) dirty$.set(!cleanDoc.eq(u.state.doc));
          }
        }),
      ],
    }),
  });

  const onScroll = () => {
    if (performance.now() < programmaticUntil) return;
    if (topLineRaf) return;
    topLineRaf = requestAnimationFrame(() => {
      topLineRaf = 0;
      try {
        const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop + 4);
        const line = view.state.doc.lineAt(block.from).number;
        handlers.ontopline(line);
      } catch {
        /* ignore */
      }
    });
  };
  view.scrollDOM.addEventListener("scroll", onScroll, { passive: true });

  return {
    destroy() {
      if (topLineRaf) cancelAnimationFrame(topLineRaf);
      view.scrollDOM.removeEventListener("scroll", onScroll);
      view.destroy();
    },
    scrollToLine(line: number) {
      const doc = view.state.doc;
      const clamped = Math.max(1, Math.min(line, doc.lines));
      try {
        const pos = doc.line(clamped).from;
        const block = view.lineBlockAt(pos);
        // block.top 以文档顶部为基准，与 scrollDOM.scrollTop 同一坐标系（差一个常数 padding，
        // 两侧采用同一约定，同步误差相互抵消）
        programmaticUntil = performance.now() + 300;
        view.scrollDOM.scrollTop = Math.max(0, block.top - 6);
      } catch {
        /* ignore */
      }
    },
    scrollToBottom() {
      programmaticUntil = performance.now() + 300;
      view.scrollDOM.scrollTop = view.scrollDOM.scrollHeight;
    },
    scrollToFractionalLine(fline: number) {
      const doc = view.state.doc;
      const clamped = Math.max(1, Math.min(fline, doc.lines));
      const i = Math.floor(clamped);
      const frac = clamped - i;
      try {
        const line = doc.line(i);
        const block = view.lineBlockAt(line.from);
        let top = block.top;
        if (frac > 0 && i < doc.lines) {
          // 用相邻行的文档坐标差作为该处行高，按小数部分插值
          const nextTop = view.lineBlockAt(doc.line(i + 1).from).top;
          top += (nextTop - block.top) * frac;
        }
        programmaticUntil = performance.now() + 300;
        view.scrollDOM.scrollTop = Math.max(0, top - 6);
      } catch {
        /* ignore */
      }
    },
    getDoc() {
      return view.state.doc.toString();
    },
    getTopLine() {
      try {
        const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop + 4);
        return view.state.doc.lineAt(block.from).number;
      } catch {
        return 1;
      }
    },
    /** 整体替换文档（外部 file:changed 事件）：替换 + 记为新基线 */
    setDoc(text: string) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
      });
      cleanDoc = view.state.doc;
      dirty$.set(false);
      /* 限定撤销历史只包含打开后的记录：卸载再重装 history（重装即全新
         空历史），同时抹掉上面全量替换自身产生的那条撤销记录 */
      view.dispatch({ effects: historyCompartment.reconfigure([]) });
      view.dispatch({
        effects: historyCompartment.reconfigure(
          history({ newGroupDelay: HISTORY_NEW_GROUP_DELAY })
        ),
      });
    },
    measure() {
      view.requestMeasure();
    },
    setIndentUnit(unit: string) {
      indent = unit;
      view.dispatch({
        effects: indentCompartment.reconfigure(indentUnit.of(unit)),
      });
    },
    requestMeasure() {
      view.requestMeasure();
    },
    /** 记录干净文档引用（初始化/保存成功后调用），并同步脏状态 */
    markClean() {
      cleanDoc = view.state.doc;
      dirty$.set(false);
    },
    setPhrases(lang: string) {
      view.dispatch({
        effects: phrasesCompartment.reconfigure(phrasesFor(lang)),
      });
    },
  };
}
