/**
 * CodeMirror 6 最小构建：
 * 不使用 `codemirror` 聚合包，只按需引入 state/view/commands/search/language，
 * Markdown 语法高亮由 @codemirror/lang-markdown（lezer）提供。
 *
 * 主题通过 CSS 变量注入（--ed-*，由 themes.css 的主题类提供），因此
 * 切换预览主题时编辑器配色同步变化，无需重新 configure。
 */
import { Annotation, EditorState, EditorSelection, Compartment, type Extension, type Text } from "@codemirror/state";
import { cmPhrases } from "../i18n-messages";
import {
  EditorView,
  ViewPlugin,
  keymap,
  crosshairCursor,
  highlightSpecialChars,
  type KeyBinding,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  undo as cmUndo,
  redo as cmRedo,
  indentMore,
  indentLess,
} from "@codemirror/commands";
import { search, searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxHighlighting, HighlightStyle, bracketMatching, indentUnit } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import type { Command } from "@codemirror/view";
import {
  registerSearchView,
  unregisterSearchView,
  handleEditorModF,
  notifyEditorUpdate,
  getPanelTopMargin,
} from "./searchPanel";
import { markdownEmphasis } from "./emphasis"
import { dirty$, setImeComposing, settingsOpen$ } from "../stores";
import { confirm$, dialogMask$ } from "../confirm";
import { get } from "svelte/store";
/* 行前缀语义单一源（markdown/table-source）：replaceLines 的
   preservePrefix 与表格源码解析共用同一前缀提取规则 */
import { extractLinePrefix, blockInsertPrefix } from "../markdown/table-source";

/**
 * 程序性反向更新标记：预览区可编辑表格等场景中，由代码驱动的
 * 文档替换（replaceLines / setDoc）必须挂载。挂载后：
 * - 光标行上报监听器跳过该事务（预览是编辑源，禁止源码光标反向拽预览）；
 * - 脏状态监听器【不受影响】——反向更新后文档照常置脏。
 * 不用 Transaction.remote：那是协同编辑的"远端变更"语义，挪用有隐患。
 */
const programmaticChange = Annotation.define<"reverseUpdate">();

/**
 * 全选事务标记：编辑区 Ctrl/Cmd+A 全选时挂载。
 * 全选把光标头瞬间推到文档末尾，若照常走光标行上报会把预览拽到文档
 * 底部、并把 App 侧的「编辑意图锚点」（lastCursorActivityAt）误判为
 * 编辑中。挂载该标记的事务被光标行上报监听器跳过——仅抑制本次全选
 * 的同步，全选后的编辑/方向键移动恢复常规光标同步。
 */
const selectAllNoCursorSync = Annotation.define<boolean>();

/** 编辑区全选命令：等价 CM6 selectAll（0 → 文档末尾），附带抑制标记 */
function selectAllSuppressCursorSync(view: EditorView): boolean {
  view.dispatch({
    selection: EditorSelection.range(0, view.state.doc.length),
    annotations: selectAllNoCursorSync.of(true),
    userEvent: "select",
  });
  return true;
}

export interface EditorHandlers {
  /** 文档内容变化（编辑器是源码的唯一编辑入口） */
  onchange: (doc: string) => void;
  /** Ctrl/Cmd+S 保存（始终保存源码） */
  onsave: () => void;
  /** 编辑器滚动：视口顶部对应源码行号（用于 编辑器→预览 同步） */
  ontopline: (line: number) => void;
  /** 光标行变化（选区移动 / 编辑）：光标所在源码行号，rAF 合并上报
   *  （用于 编辑器→预览 光标行同步，保障编辑行不被预览高块挤出视窗） */
  oncursorline: (line: number) => void;
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
  /** 在当前光标处插入文本（有选区时替换选区）。cursorOffset 可选：插入后
   *  光标落点相对插入文本起点的偏移（缺省 = 文本末尾）。用于底栏表格
   *  插入（光标落进首个表头单元格）。 */
  insertText(text: string, cursorOffset?: number): void;
  /** 在当前光标处插入块级内容（表格 / 代码块等），多行内容每行继承
   *  光标所在行的结构前缀：引用/缩进原样保留；列表标记替换为等宽空白，
   *  使块成为列表项内容。语义：
   *  - 空行 → 整行替换（继承该行空白前缀）；
   *  - 行尾（无选区）→ 光标处换行后插入（列表项/引用下方新起一块）；
   *  - 行中 / 有选区 → 退化为 insertText（直接替换，不加前缀）。
   *  cursorOffset：相对「裸 text」的光标落点，前缀自动计入。 */
  insertBlock(text: string, cursorOffset?: number): void;
  /** 替换指定行区间（1-based，含端点）为给定文本。用于预览区可编辑表格
   * 的反向更新（整表源码替换，行数可增减，undo 可整体回退）。
   * cursorOffsetInText：光标在替换文本内的字符偏移（可选）。 */
  replaceLines(startLine: number, endLine: number, text: string,
    cursorOffsetInText?: number, preservePrefix?: boolean): void;
  /** 注册反向更新前置钩子：replaceLines 每次调用前触发。
   * 供 App 清理残留的光标同步状态（pendingCursorLine /
   * lastCursorActivityAt），防止 blocks 重建后旧光标行拽动预览。
   * 返回注销函数。 */
  onBeforeReplace(fn: () => void): () => void;
  /** 隐藏后重新显示时请求重新测量几何信息 */
  measure(): void;
  /** 切换缩进单位（设置里选择制表符 / 空格），动态重配置无需重建编辑器 */
  setIndentUnit(unit: string): void;
  /** 切换界面语言后重配 CM6 phrases（查找面板文案随语言更新） */
  setPhrases(lang: string): void;
  /** 字号变化后请求重新测量布局（CSS 变量变化不会自动触发 CM 测量） */
  requestMeasure(): void;
  /** 全局 Ctrl+F 入口已由独立悬浮面板接管（searchPanel.ts），此处仅提供
      面板开合时编辑区顶部余量的动态重配置（悬浮面板不占布局高度） */
  setSearchPanelMargin(enabled: boolean): void;
  /** 记录干净文档引用（初始化/保存成功后调用） */
  markClean(): void;
  /** 撤销：全局快捷键入口（焦点不在任意 CM6 实例内时由 App 调用，
   *  始终作用于编辑区实例；无撤销记录时 CM6 命令静默失败） */
  undo(): void;
  /** 重做：全局快捷键入口（同上） */
  redo(): void;
}

/** 缩进命令包装：执行后把选区头滚入视口（供主编辑器的 Tab/Shift-Tab 用） */
function indentWithScroll(cmd: Command, beforeScroll?: () => void): Command {
  return (view) => {
    if (!cmd(view)) return false;
    beforeScroll?.();
    view.dispatch({
      effects: EditorView.scrollIntoView(
        view.state.selection.main.head,
        { y: "nearest", yMargin: 6 },
      ),
    });
    return true;
  };
}

/** 查找悬浮面板打开时的顶部滚动余量（面板高度 + 间距；关闭时为 null 不让位） */
function panelMarginExt(enabled: boolean): Extension {
  return EditorView.scrollMargins.of(() =>
    enabled ? { top: getPanelTopMargin() } : null
  );
}

/* 输入停顿多久后合并为新的撤销组（CM6 默认 500ms，收紧为 200ms）。
 * 主编辑器与单元格编辑器共用同一取值（编辑区同配置的一部分） */
const HISTORY_NEW_GROUP_DELAY = 200;
/** 全局缩进单位镜像（兼容旧调用点）：主编辑器创建 / setIndentUnit 时同步。
 *  新代码应把缩进单位显式传给 createCellEditor；此变量仅作为其缺省回退。 */
let sharedIndentUnit = "  ";

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
    cursor: "text",
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
  /* 查找匹配项：主题柔和色底（--ed-search，各主题注入） */
  ".cm-searchMatch": {
    backgroundColor: "var(--ed-search)",
  },
  /* 当前匹配项（CM6 的 cm-searchMatch-selected）：复用选区背景色，与匹配项区分 */
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "var(--ed-selection)",
  },
  ".cm-activeLine": { backgroundColor: "var(--ed-activeline)" },
  ".cm-panels-top": { display: "none" },
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

/* ---------------- 主编辑器与单元格编辑器共享的扩展片段 ----------------
 *
 * 两个工厂的差异是“职责性”的（生命周期、Compartment、面板、专属键位、
 * 主题布局、返回类型），不适合合并成一个带大量 option 的通用工厂；
 * 但“无参数、无副作用、语义完全一致”的部分应提出来，避免两处漂移。
 * 新增/调整通用 Markdown 编辑行为时，只改这里。
 */

/** 两边共用的 Markdown 编辑扩展（语言、选区策略、高亮、特殊字符处理）。 */
function commonMarkdownExtensions(): Extension[] {
  return [
    highlightSpecialChars(),
    crosshairCursor(),
    bracketMatching(),
    highlightSelectionMatches(),
    markdownEmphasis(),
    /* 禁用多光标：false 时状态层把任何新选区 asSingle() 折叠，
       Ctrl/Cmd+Click、矩形拖拽、Ctrl-Alt-↑/↓ 等所有入口一并失效 */
    EditorState.allowMultipleSelections.of(false),
    /* 拖拽永远视为“移动”而非“添加”：Alt/Ctrl+左键拖拽不再产生
       选区/光标扩展（矩形选区扩展已移除，此为兜底） */
    EditorView.dragMovesSelection.of(() => true),
    EditorView.lineWrapping,
    markdown(),
    syntaxHighlighting(mdHighlight),
  ];
}

/** 两边共用的按键（撤销/重做/反向缩进 + CM 默认键位）。
 *  - 调用方专属键（Mod-s / Mod-f / Tab / Mod-Enter / Esc）由各自工厂
 *    按需前置声明，不在此列；
 *  - 自定义 Mod-z / Mod-y 必须排在 historyKeymap 之前，这里已保证。 */
function commonKeymap(): KeyBinding[] {
  return [
    { key: "Mod-z", run: cmUndo, shift: cmRedo },
    { key: "Mod-y", run: cmRedo },
    ...defaultKeymap,
    ...historyKeymap,
  ];
}

/* ---------------- 创建编辑器 ---------------- */

export function createEditorApi(
  parent: HTMLElement,
  initialDoc: string,
  handlers: EditorHandlers,
  initialIndent: string,
  initialLang = "en"
): EditorApi {
  let topLineRaf = 0;
  /* 程序化滚动抑制（两级）：
     - programmaticScrollArmed：markProgrammaticScroll 置位的“待消费”
       标记。onScroll 收到的第一个滚动事件若处于窗口内，视为程序化
       滚动自身的事件——消费掉武装标记，并把抑制窗口收缩为 80ms
       （仅用于吸收 scrollIntoView 测量修正可能引发的第二跳）。
       此后紧跟的用户滚动（哪怕距程序化滚动仅 100ms）都正常上报——
       旧的纯时间窗方案会把“插入后立刻滚走”误判为程序化滚动，
       造成预览不跟随，是重复插入冻结问题的诱因之一。
     - programmaticUntil：300ms 主窗口，作为“置位后未发生滚动”的
       兜底；若窗口到期仍无滚动事件，onScroll 会先解除武装再按普通
       滚动处理，防止标记滞留误吞后续用户滚动。 */
  let programmaticUntil = 0;
  let programmaticScrollArmed = false;

  function markProgrammaticScroll(): void {
    programmaticScrollArmed = true;
    programmaticUntil = performance.now() + 300;
  }

  /* 光标行上报：选区/文档更新后经 rAF 合并，同一帧内多次变化只报最终值 */
  let cursorLineRaf = 0;
  let pendingCursorState: EditorState | null = null;

  /* 缩进单位用 Compartment 动态重配置（设置切换 制表符/空格 时生效） */
  const indentCompartment = new Compartment();
  sharedIndentUnit = initialIndent;
  /* 历史独立 Compartment：打开文档时卸载再重装 = 清空撤销历史 */
  const historyCompartment = new Compartment();
  const phrasesCompartment = new Compartment();
  /* 可编辑性 Compartment：任一遮罩（设置面板 / confirm 弹窗 / 系统弹窗
     空白遮罩）开启期间切换为不可编辑，全部关闭后恢复
     （响应 settingsOpen$ / confirm$ / dialogMask$ 开关状态） */
  const editableCompartment = new Compartment();
  /* 查找悬浮面板顶部余量 Compartment：面板开合时动态重配置
     scrollMargins（悬浮卡片不占布局高度，改由 facet 让编辑器滚动留边） */
  const searchMarginCompartment = new Compartment();
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
        ...commonMarkdownExtensions(),
        historyCompartment.of(history({ newGroupDelay: HISTORY_NEW_GROUP_DELAY })),
        indentCompartment.of(indentUnit.of(initialIndent)),
        phrasesCompartment.of(phrasesFor(initialLang)),
        editableCompartment.of([
          EditorView.editable.of(true),
          EditorState.readOnly.of(false),
        ]),
        editorTheme,
        /** 占位以确保原生行为可用 */
        search({
          createPanel: () => {
            const dom = document.createElement("div");
            dom.style.display = "none";
            return { dom, top: true };
          },
        }),
        /* 悬浮面板打开时让出的顶部滚动余量（面板不占布局高度，用 facet 动态让位） */
        searchMarginCompartment.of(panelMarginExt(false)),
        keymap.of([
          // Mod-f：统一由悬浮面板接管（面板已开时拉取选区到关键词框）
          { key: "Mod-f", run: () => handleEditorModF() },
          { key: "Mod-s", preventDefault: true, run: () => (handlers.onsave(), true) },
          // 全选：抑制基于光标的滚动同步（见 selectAllNoCursorSync 注释）。
          // 只挂在主编辑区——单元格编辑器无光标同步，保持 CM6 默认全选。
          { key: "Mod-a", run: selectAllSuppressCursorSync },
          { key: "Tab", run: indentWithScroll(indentMore, markProgrammaticScroll) },
          { key: "Shift-Tab", run: indentWithScroll(indentLess, markProgrammaticScroll) },
          ...commonKeymap(),
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            handlers.onchange(u.state.doc.toString());
            if (cleanDoc) {
              // 脏状态对所有文档统一口径：内容与干净基线不一致即脏
              //（未命名文档不再特殊处理，其差异仅保留在保存路径——
              // 无路径文档保存始终走另存为，见 App 的 save()）
              dirty$.set(!cleanDoc.eq(u.state.doc));
            }
          }
        }),
        /* 查找面板统计（当前项下标随选区/文档变化刷新） */
        EditorView.updateListener.of((u) => notifyEditorUpdate(u)),
        /* 光标行上报（编辑器→预览 光标行同步的信号源）：
           选区变化（点击/方向键）与编辑（光标头随输入前移）都会触发；
           经 rAF 合并，连续输入只上报当帧最终光标行。setDoc（打开/外部
           重载）触发的上报会把同步目标带回首行，与「新文档从顶部展示」
           语义一致；程序性滚动（scrollToLine）不改变选区，不会误触发。 */
        EditorView.updateListener.of((u) => {
          if (!u.selectionSet && !u.docChanged) return;
          // 程序性反向更新（预览表格回写等）：预览是编辑源，不触发
          // 源码→预览的光标行同步。跳过上报，避免污染 App 侧的
          // lastCursorActivityAt（编辑意图锚点判定）与 pendingCursorLine。
          // 注意：u.transactions 是本次 update 的事务数组，需用 some 聚合判断。
          if (u.transactions.some((tr) => tr.annotation(programmaticChange))) return;
          // 全选（Ctrl/Cmd+A）：光标头被推到文档末尾属选区操作而非编辑
          // 意图，跳过本次上报——不把预览拽到文档底部，也不污染
          // lastCursorActivityAt。仅抑制全选事务本身，后续编辑恢复同步。
          if (u.transactions.some((tr) => tr.annotation(selectAllNoCursorSync))) return;
          pendingCursorState = u.state;
          if (cursorLineRaf) return;
          cursorLineRaf = requestAnimationFrame(() => {
            cursorLineRaf = 0;
            const st = pendingCursorState;
            pendingCursorState = null;
            if (!st) return;
            try {
              handlers.oncursorline(st.doc.lineAt(st.selection.main.head).number);
            } catch {
              /* ignore */
            }
          });
        }),
        /* 输入法组合事件上报：compositionstart/end 经 setImeComposing 写入
           全局 imeComposing$，解析调度器在组合期间永不发起请求（组合中的
           临时文本不进预览，组合结束后重新起防抖统一解析最终内容）。
           返回 false：只上报状态，不拦截事件、不影响默认组合行为。 */
        EditorView.domEventHandlers({
          compositionstart: () => {
            setImeComposing(true);
            return false;
          },
          compositionend: () => {
            setImeComposing(false);
            return false;
          },
        }),
        /**
         * CodeMirror 6 扩展：点击编辑器底部 padding 区域时，将光标定位到文档末尾。
         *
         * 背景：
         * - CodeMirror 默认在点击 cm-scroller 的 padding-bottom 空白区域时，
         *   可能把光标定位到可视区域中间，而不是文档末尾。
         * - 本插件在 cm-scroller 上以捕获阶段监听 mousedown，
         *   在 CodeMirror 内部选区逻辑之前拦截该点击。
         *
         * 判断方式：
         * - 用 lineBlockAt(lastLine.from) 获取最后一行行块在文档坐标系中的 bottom；
         * - 加上 view.documentTop 转成屏幕坐标；
         * - 若 event.clientY > 最后一行底部，则视为点击底部空白。
         *
         * 处理方式：
         * - preventDefault + stopPropagation 阻止默认跳转；
         * - 下一帧 dispatch 将 selection 设为 EditorSelection.cursor(doc.length)；
         * - 调用 view.focus() 确保光标可见。
         *
         * 注意：
         * - 文档以换行结尾时，doc.length 会落在最后一个空行；
         * - 当前不处理在 padding 区域拖拽选择的复杂情况；
         * - 必须在 destroy 中移除捕获阶段监听器，避免泄漏。
         */
        ViewPlugin.fromClass(class {
          view: EditorView;
          scroller: HTMLElement;
          handler: (event: MouseEvent) => void;

          constructor(view: EditorView) {
            this.view = view;
            this.scroller = view.scrollDOM;

            this.handler = (event: MouseEvent) => {
              const doc = this.view.state.doc;
              const lastLine = doc.lineAt(doc.length);
              const lastLineBlock = this.view.lineBlockAt(lastLine.from);
              if (!lastLineBlock) return;

              const lastLineBottomScreen = this.view.documentTop + lastLineBlock.bottom;

              if (event.clientY > lastLineBottomScreen) {
                // 1. 先阻止默认行为，避免光标跳到中间
                event.preventDefault();
                event.stopPropagation();

                // 2. 延迟到下一帧派发，避开 mousedown 的后续内部处理
                requestAnimationFrame(() => {
                  this.view.dispatch({
                    selection: EditorSelection.cursor(doc.length),
                    userEvent: "select.pointer",
                  });
                  // 3. 确保编辑器获得焦点，光标才会显示
                  this.view.focus();
                });
              }
            };

            this.scroller.addEventListener('mousedown', this.handler, true);
          }

          destroy() {
            this.scroller.removeEventListener('mousedown', this.handler, true);
          }
        }),
      ],
    }),
  });

  const onScroll = () => {
    if (programmaticScrollArmed) {
      programmaticScrollArmed = false;
      if (performance.now() < programmaticUntil) {
        // 程序化滚动自身的事件：消费掉，收缩窗口吸收测量修正第二跳
        programmaticUntil = performance.now() + 80;
        return;
      }
      // 窗口已过仍才发生滚动：解除武装，按普通滚动处理
    }
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

  /* 遮罩联动：任一遮罩（设置面板 / confirm 弹窗 / 系统弹窗空白遮罩，
     与 App 快捷键的 overlayOpen 同口径）开启期间编辑器切换为不可编辑
     （CM6 会同步移除 contenteditable 并拒绝输入），全部关闭后恢复。
     三个源订阅同一同步函数，状态变化经去重后才 dispatch，
     避免创建期与同值切换产生无谓的重配置事务。 */
  let overlayOn = false;
  const syncEditable = () => {
    const on =
      get(settingsOpen$) || get(confirm$) !== null || get(dialogMask$);
    if (on === overlayOn) return;
    overlayOn = on;
    view.dispatch({
      effects: editableCompartment.reconfigure([
        EditorView.editable.of(!on),
        EditorState.readOnly.of(on),
      ]),
    });
  };
  const unsubOverlays = [
    settingsOpen$.subscribe(syncEditable),
    confirm$.subscribe(syncEditable),
    dialogMask$.subscribe(syncEditable),
  ];

  /* 反向更新前置钩子：EditableTable 经 replaceLines 回写表格前，
   App 侧需要先清残留同步状态。钩子集在 createEditorApi 作用域内，
   随编辑器销毁一并失效 */
  const beforeReplaceHooks = new Set<() => void>();

  /* 视图注册到查找悬浮面板（面板通过它驱动 CM6 搜索管线） */
  registerSearchView(view);

  return {
    destroy() {
      unregisterSearchView();
      for (const unsub of unsubOverlays) unsub();
      if (topLineRaf) cancelAnimationFrame(topLineRaf);
      if (cursorLineRaf) cancelAnimationFrame(cursorLineRaf);
      view.scrollDOM.removeEventListener("scroll", onScroll);
      view.destroy();
    },
    scrollToLine(line: number) {
      const doc = view.state.doc;
      const clamped = Math.max(1, Math.min(line, doc.lines));
      try {
        const pos = doc.line(clamped).from;
        // 经 CM6 的 scrollIntoView 落点：它会把目标行纳入 viewport、完成
        // 测量修正 heightmap 后再计算滚动位置。直接写 scrollTop 用的是
        // 未测量区的估计几何（lineWrapping 下行高估计误差随距离累积），
        // 落点后 CM6 实测修正 → 行位置漂移，即大纲跳转概率性对不齐的根因。
        // y:"start" + yMargin:6 与旧约定（scrollTop = block.top - 6）一致。
        markProgrammaticScroll();
        view.dispatch({
          effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: 6 }),
        });
      } catch {
        /* ignore */
      }
    },
    scrollToBottom() {
      markProgrammaticScroll();
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
        const far = Math.abs(block.top - view.scrollDOM.scrollTop) > view.scrollDOM.clientHeight * 2;
        // 置位一次即可：远距路径的第一跳（scrollIntoView）被 armed 消费，
        // 第二跳（measure 回调写 scrollTop）落入收缩后的 80ms 短窗
        markProgrammaticScroll();
        if (far) {
          // 远距目标（预览快速滚动空窗后一次性跟随）：走 CM6 的测量感知
          // 落点（同 scrollToLine），落到整行后在 measure 回调里按实测
          // 行高补小数插值；预览持续同步随后逐帧自纠
          view.dispatch({
            effects: EditorView.scrollIntoView(line.from, { y: "start", yMargin: 6 }),
          });
          view.requestMeasure({
            read: () => view.lineBlockAt(line.from).top,
            write: (top: number) => {
              let t = top;
              if (frac > 0 && i < doc.lines) {
                const nextTop = view.lineBlockAt(doc.line(i + 1).from).top;
                t += (nextTop - top) * frac;
              }
              view.scrollDOM.scrollTop = Math.max(0, t - 6);
            },
          });
          return;
        }
        // 近距目标（连续同步，逐帧小步）：几何已实测，直接写保持跟手
        let top = block.top;
        if (frac > 0 && i < doc.lines) {
          // 用相邻行的文档坐标差作为该处行高，按小数部分插值
          const nextTop = view.lineBlockAt(doc.line(i + 1).from).top;
          top += (nextTop - block.top) * frac;
        }
        view.scrollDOM.scrollTop = Math.max(0, top - 6);
      } catch {
        /* ignore */
      }
    },
    getDoc() {
      return view.state.doc.toString();
    },
    /** 光标处插入文本（选区替换）。光标按 cursorOffset 落位，滚动可见并聚焦。
     *  程序化 dispatch 不会像用户输入那样自动滚到选区，必须显式
     *  scrollIntoView；markProgrammaticScroll 抑制本次滚动引发的
     *  ontopline 回写（防止顶行锚定覆盖光标锚定的预览同步）。
     *  不挂 programmaticChange 注解：这是用户编辑意图，光标行上报
     *  必须照常进行，预览侧由 trySyncCursor / blocks 重建“编辑中”
     *  分支跟随到插入点。 */
    insertText(text: string, cursorOffset?: number) {
      const sel = view.state.selection.main;
      const off = cursorOffset == null ? text.length : Math.max(0, Math.min(cursorOffset, text.length));
      const pos = sel.from + off;
      markProgrammaticScroll();
      view.dispatch({
        changes: { from: sel.from, to: sel.to, insert: text },
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: "nearest", yMargin: 6 }),
        userEvent: "input.insert",
      });
      view.focus();
    },
    insertBlock(text: string, cursorOffset?: number) {
      const sel = view.state.selection.main;
      const line = view.state.doc.lineAt(sel.from);
      const atLineEnd = sel.from === line.to;
      const lineEmpty = line.text.trim() === "";
      const hasSelection = sel.from !== sel.to;
      const rawOffset = cursorOffset == null
        ? text.length
        : Math.max(0, Math.min(cursorOffset, text.length));

      let from = sel.from;
      let to = sel.to;
      let insert: string;
      let off: number;

      if (hasSelection || (!lineEmpty && !atLineEnd)) {
        // 有选区 / 光标在行中：退化到 insertText 语义（无前缀）
        insert = text;
        off = rawOffset;
      } else if (lineEmpty) {
        // 空行：整行替换，继承该行空白前缀（用户手动缩进）
        const prefix = blockInsertPrefix(line.text);
        insert = text.split("\n").map((l) => prefix + l).join("\n");
        from = line.from;
        to = line.to;
        off = prefix.length + rawOffset;
      } else {
        // 行尾无选区：在光标处新起一行，前缀继承（列表标记转缩进）
        const prefix = blockInsertPrefix(line.text);
        insert = "\n" + text.split("\n").map((l) => prefix + l).join("\n");
        off = 1 + prefix.length + rawOffset;
      }

      const pos = from + off;
      markProgrammaticScroll();
      view.dispatch({
        changes: { from, to, insert },
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: "nearest", yMargin: 6 }),
        userEvent: "input.insert",
      });
      view.focus();
    },
    /** 行区间替换（1-based，含端点；区间外越界按文档边界收敛）。
     *
     * 用于预览区可编辑表格的反向更新：整表源码替换，行数可增减，
     * undo 可整体回退。
     *
     * cursorOffsetInText：光标落点在【替换文本 text 内】的字符偏移
     * （0-based，越界收敛到 text.length）。可选：
     * - 传入被编辑单元格在整表源码内的偏移 → 替换后光标精确落在该处，
     *   blocks 重建后的重对齐目标落在表格附近（兜底语义）；
     * - 缺省 → 光标落在替换起点。
     *
     * 抑制语义（三条，缺一不可）：
     * 1. programmaticUntil：本次变更可能引发编辑器滚动（原选区被映射/
     *    替换后 CM6 滚到选区），抑制 scroll → ontopline 上报，
     *    防止编辑器顶行回写预览（deadline 模式，同 scrollToLine 先例，
     *    只设不清，scroll 事件异步到达时窗口必须仍然有效）；
     * 2. programmaticChange 注解：光标行上报监听器跳过本事务，
     *    不刷新 App 侧 lastCursorActivityAt / pendingCursorLine，
     *    blocks 重建后走"非编辑"分支（顶行对齐 + 去重），而非
     *    "编辑中"分支（光标行对齐——跳顶的根因）；
     * 3. 显式 selection：不依赖 CM6 对旧选区的隐式映射，消灭映射
     *    不确定性；即使上述两条漏防，跳变目标也落在表格内而非顶部。
     *
     * 允许的行为边界：替换后 blocks 重建，若行数变化导致块偏移漂移
     * 超过去重阈值（8px），允许一次小幅重对齐；禁止的是跳回光标行
     * 或文档顶部。
     *
     * preservePrefix（P3，缺省 false，向后兼容）：为 true 时按行保留
     * 被替换区间的「行前缀」（缩进 / 引用 > / 列表标记及其后空格，语义
     * 单一源 = markdown/table-source 的 extractLinePrefix），只替换每行
     * 的内容区——反向更新不再冲掉表格所在的缩进/引用/列表上下文。
     * - 前缀取自【当前文档】的对应行（权威来源，非调用方缓存）；替换后
     *   新增行（行数变多）沿用最后一个原行的前缀，删除行自然消失；
     * - cursorOffsetInText 语义不变：仍是【text（内容区拼接）内】的偏移，
     *   按行号 + 列号映射到加前缀后的最终文本（前缀长度自动计入）。
     */
    replaceLines(startLine: number, endLine: number, text: string,
      cursorOffsetInText?: number, preservePrefix = false): void {
      for (const fn of beforeReplaceHooks) fn();
      const doc = view.state.doc;
      if (doc.lines === 0) return;
      const a = Math.max(1, Math.min(startLine, doc.lines));
      const b = Math.max(a, Math.min(endLine, doc.lines));
      const from = doc.line(a).from;
      if (!preservePrefix) {
        const off = cursorOffsetInText == null
          ? 0
          : Math.max(0, Math.min(cursorOffsetInText, text.length));
        markProgrammaticScroll();
        view.dispatch({
          changes: { from, to: doc.line(b).to, insert: text },
          selection: { anchor: from + off },
          annotations: programmaticChange.of("reverseUpdate"),
          userEvent: "input.replace",
        });
        return;
      }
      /* 前缀保留路径：text 视为「裸」内容行（无前缀） */
      const contentLines = text.split("\n");
      const prefixCount = b - a + 1;
      const prefixes: string[] = [];
      for (let i = 0; i < prefixCount; i++) {
        prefixes.push(extractLinePrefix(doc.line(a + i).text));
      }
      const prefixAt = (i: number): string =>
        prefixes[Math.min(i, prefixes.length - 1)] ?? "";
      const finalText = contentLines
        .map((l, i) => prefixAt(i) + l)
        .join("\n");
      /* 内容区偏移 → 最终文本偏移：定位偏移所在的行/列，加前缀长度 */
      let off = 0;
      if (cursorOffsetInText != null) {
        const off0 = Math.max(0, Math.min(cursorOffsetInText, text.length));
        let line = 0;
        let col = off0;
        for (; line < contentLines.length - 1; line++) {
          const len = contentLines[line].length + 1;
          if (col < len) break;
          col -= len;
        }
        let finalOff = col;
        for (let i = 0; i <= line && i < contentLines.length; i++) {
          finalOff += prefixAt(i).length + contentLines[i].length + 1;
        }
        off = finalOff - 1; /* 循环多加了一个行终止符 */
      }
      markProgrammaticScroll();
      view.dispatch({
        changes: { from, to: doc.line(b).to, insert: finalText },
        selection: { anchor: from + Math.min(off, finalText.length) },
        annotations: programmaticChange.of("reverseUpdate"),
        userEvent: "input.replace",
      });
    },
    onBeforeReplace(fn: () => void) {
      beforeReplaceHooks.add(fn);
      return () => { beforeReplaceHooks.delete(fn); };
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
      sharedIndentUnit = unit;
      view.dispatch({
        effects: indentCompartment.reconfigure(indentUnit.of(unit)),
      });
    },
    requestMeasure() {
      view.requestMeasure();
    },
    /** 查找悬浮面板开合：动态重配置编辑区顶部滚动余量 */
    setSearchPanelMargin(enabled: boolean) {
      view.dispatch({
        effects: searchMarginCompartment.reconfigure(panelMarginExt(enabled)),
      });
    },
    /** 记录干净文档引用（初始化/保存成功后调用），并同步脏状态 */
    markClean() {
      cleanDoc = view.state.doc;
      dirty$.set(false);
    },
    undo() {
      cmUndo(view);
    },
    redo() {
      cmRedo(view);
    },
    setPhrases(lang: string) {
      view.dispatch({
        effects: phrasesCompartment.reconfigure(phrasesFor(lang)),
      });
    },
  };
}

/* ============================================================
 * 单元格编辑器（可编辑表格用）：与编辑区同配置的 CM6 实例
 * ============================================================
 * - 与编辑区共用同一套语言（markdown / lezer 高亮）、自动换行、
 *   按键（defaultKeymap / historyKeymap / Tab 缩进）、撤销历史参数
 *   与 --ed-* 主题变量；仅去掉编辑区面板专属能力（查找面板、
 *   滚动同步上报、IME 全局闸门、遮罩禁用、Mod-s）；
 * - 懒创建：EditableTable 首次进入单元格编辑时才构建实例；
 * - 冻结复用：结束单元格编辑后不销毁实例，DOM 脱离文档挂起
 *   （Svelte 卸载宿主节点即完成冻结），下次编辑把 dom 重新挂载
 *   并整体换文档（history 卸载重装 = 清空撤销历史）；
 * - 自适应：height:auto + scroller 不滚动 → 编辑器随内容撑高，
 *   单元格随之变宽变高；换行（自动换行 / 用户插入 \n）后把光标
 *   滚动进最近的可滚动祖先（预览滚动容器）可视区。
 */

export interface CellEditorHandlers {
  /** 文档变化（EditableTable 同步 editValue + 触发防抖实时解析） */
  onchange: (doc: string) => void;
  /** Ctrl/Cmd+Enter 或失焦：提交编辑 */
  oncommit: () => void;
  /** Esc：取消编辑 */
  oncancel: () => void;
}

export interface CellEditorHandle {
  /** .cm-editor 根节点（冻结期间由调用方持有，复用时重新挂载） */
  dom: HTMLElement;
  /** 整体替换文档（复用实例换单元格时调用，撤销历史随重装清空） */
  setDoc(text: string): void;
  /** 光标移到文档末尾并聚焦（重新挂载进文档后调用） */
  focusEnd(): void;
  /** 重新挂载后触发一次量测（脱离/进入文档后 CM 需重新测量几何） */
  requestMeasure(): void;
  destroy(): void;
}

/** 单元格编辑器主题：配色/字体沿用编辑区的 --ed-* 变量，但布局改为
 * 随内容自适应（编辑区是 100% 高的滚动面板，单元格必须撑开 <td>） */
const cellEditorTheme = EditorView.theme({
  "&": {
    height: "auto",
    maxWidth: "100%",
    backgroundColor: "transparent",
    color: "var(--ed-fg)",
    fontSize: "inherit",
  },
  ".cm-scroller": {
    height: "auto", /** 覆盖 baseTheme 的 height: 100% */
    fontFamily: "var(--ed-font-family, ui-monospace, monospace)",
    lineHeight: "1.78",
    padding: "0",
    /* 高度完全由内容决定，不产生内部滚动（滚动交给页面滚动容器） */
    overflow: "hidden",
    cursor: "text",
  },
  ".cm-content": {
    caretColor: "var(--ed-accent)",
    padding: "0",
    minHeight: "0", /** 覆盖 baseTheme 的 min-height: 100% */
  },
  ".cm-line": { padding: "0" },
  ".cm-cursor": { borderLeftColor: "var(--ed-accent)", borderLeftWidth: "2px" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "var(--ed-selection)",
  },
  ".cm-selectionMatch": { backgroundColor: "var(--ed-selection)" },
});

/** 换行/插行后保持光标可见：编辑器自身无内部滚动（高度自适应），
 * 需要滚的是最近的可滚动祖先（预览滚动容器）。仅向下滚动——
 * 自动换行与插入 \n 都只会让内容向下增长。 */
function scrollCaretIntoViewAncestor(view: EditorView): void {
  const head = view.state.selection.main.head;
  let coords: { top: number; bottom: number } | null = null;
  try {
    coords = view.coordsAtPos(head);
  } catch {
    return; // 视口外 / 量测中：跳过本次
  }
  if (!coords) return;
  let el: HTMLElement | null = view.dom.parentElement;
  while (el && el !== document.body) {
    const oy = getComputedStyle(el).overflowY;
    if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 1) {
      const box = el.getBoundingClientRect();
      const margin = 24;
      if (coords.bottom > box.bottom - margin) {
        el.scrollTop += coords.bottom - box.bottom + margin;
      } else if (coords.top < box.top) {
        el.scrollTop -= box.top - coords.top;
      }
      return;
    }
    el = el.parentElement;
  }
}

/** 创建单元格编辑器（EditableTable 懒调用：首次编辑单元格才创建）。
 * 返回的实例在编辑结束后由调用方「冻结」——只要不 destroy，dom 脱离
 * 文档仍然存活，下一次编辑重新 appendChild 即可复用。
 *
 * indentUnitValue：Tab 缩进单位。推荐调用方显式传入主编辑器当前缩进
 * （例如从设置 store 读取），避免依赖模块级 sharedIndentUnit 镜像；
 * 缺省仍回退到 sharedIndentUnit 以兼容旧调用点。 */
export function createCellEditor(
  parent: HTMLElement,
  initialDoc: string,
  handlers: CellEditorHandlers,
  indentUnitValue: string = sharedIndentUnit
): CellEditorHandle {
  /* 换文档时卸载再重装 history = 清空撤销历史（与编辑区 setDoc 同策略） */
  const historyCompartment = new Compartment();
  let scrollRaf = 0;

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: initialDoc,
      extensions: [
        ...commonMarkdownExtensions(),
        historyCompartment.of(history({ newGroupDelay: HISTORY_NEW_GROUP_DELAY })),
        indentUnit.of(indentUnitValue),
        cellEditorTheme,
        keymap.of([
          { key: "Mod-Enter", preventDefault: true, run: () => (handlers.oncommit(), true) },
          { key: "Escape", preventDefault: true, run: () => (handlers.oncancel(), true) },
          { key: "Tab", run: indentMore },
          { key: "Shift-Tab", run: indentLess },
          ...commonKeymap(),
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            handlers.onchange(u.state.doc.toString());
            /* 换行（自动换行 / 插入 \n）→ 内容高度增长，rAF 后把光标
             * 滚动进最近可滚动祖先的可视区（只向下） */
            cancelAnimationFrame(scrollRaf);
            scrollRaf = requestAnimationFrame(() => scrollCaretIntoViewAncestor(view));
          }
        }),
        EditorView.domEventHandlers({
          /* 与旧 textarea 行为一致：失焦即提交（Esc 取消路径不会走到这里） */
          blur: () => {
            handlers.oncommit();
            return false;
          },
        }),
      ],
    }),
  });

  return {
    dom: view.dom,
    setDoc(text: string) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        /* 换文档：卸载再重装 history = 全新撤销历史 */
        effects: historyCompartment.reconfigure([]),
      });
      view.dispatch({
        effects: historyCompartment.reconfigure(
          history({ newGroupDelay: HISTORY_NEW_GROUP_DELAY })
        ),
      });
    },
    focusEnd() {
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      view.focus();
    },
    requestMeasure() {
      view.requestMeasure();
    },
    destroy() {
      cancelAnimationFrame(scrollRaf);
      view.destroy();
    },
  };
}