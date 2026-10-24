<script lang="ts">
  import { onMount } from "svelte";
  import CodePane from "./lib/editor/CodePane.svelte";
  import PreviewPane from "./lib/preview/PreviewPane.svelte";
  import BottomBar from "./components/BottomBar.svelte";
  import OutlinePanel from "./components/OutlinePanel.svelte";
  import SettingsModal from "./components/SettingsModal.svelte";
  import {
    applyThemeVars,
    buildFontChain,
    EDITOR_FONT_FALLBACK,
    PREVIEW_FONT_FALLBACK,
  } from "./lib/themes";
  import Toast from "./components/Toast.svelte";
  import ContextMenu from "./components/ContextMenu.svelte";
  import ConfirmDialog from "./components/ConfirmDialog.svelte";
  import Banner from "./components/Banner.svelte";
  import { dialogMask$ as dialogMask } from "./lib/confirm";
  import {
    saveDocument,
    confirmQuit,
    onBackendEvent,
    reportDirty,
    pickOpenPaths,
    openDocument,
    newInstance,
    closeWindow,
    setTitle,
  } from "./lib/bridge";
  import { confirmDialog, confirm$ } from "./lib/confirm";
  import {
    mode$ as mode,
    theme$ as theme,
    indent$ as indent,
    settingsOpen$ as settingsOpen,
    outlineOpen$ as outlineOpen,
    outlineAutoTrack$ as outlineAutoTrack,
    topIndex$ as topIndex,
    toast$ as toast,
    doc$ as doc,
    ready$ as ready,
    blocks$ as blocks,
    segments$ as segments,
    fontEditor$ as fontEditor,
    fontPreview$ as fontPreview,
    fontSizeEd$ as fontSizeEd,
    fontSizePv$ as fontSizePv,
    outline$ as outline,
    activeHeading$ as activeHeading,
    dirty$ as dirty,
    guardDirty$ as guardDirty,
    editorApi$ as editorApi,
    previewApi$ as previewApi,
    bootApp,
    indexOfLine,
    docState$ as docState,
    loadOpenedDoc,
    saveFileAs,
  } from "./lib/stores";
  import { setLang, currentLang, t } from "./lib/i18n.svelte";
  import type { Mode, OutlineItem, PreviewApi } from "./lib/types";
  import type { EditorApi } from "./lib/editor/codemirrorSetup";
  import { get } from "svelte/store";

  const indentUnit: Record<string, string> = {
    tab: "\t",
    space2: "  ",
    space4: "    ",
  };
  const SYNC_OFFSET = 8;

  /* ---------------- 主题/字体/字号：脚本注入根元素变量（store 驱动） ---------------- */
  $effect(() => {
    const el = document.querySelector<HTMLElement>(".app");
    if (el) {
      applyThemeVars(
        el,
        $theme,
        buildFontChain($fontEditor, EDITOR_FONT_FALLBACK),
        buildFontChain($fontPreview, PREVIEW_FONT_FALLBACK),
        $fontSizeEd,
        $fontSizePv,
      );
      $editorApi?.requestMeasure();
    }
  });

  /* 缩进单位变化 → 动态重配置编辑器（Compartment，无需重建） */
  $effect(() => {
    const api = $editorApi;
    if (api) api.setIndentUnit(indentUnit[$indent]);
  });

  /* 反向更新前置清理（预览表格回写 EditableTable → replaceLines）：
   * - pendingCursorLine：用户"先在编辑器打字 → 再点进预览表格"的常见
   *   顺序会留下未完成的光标同步待办，blocks 重建时 trySyncCursor 会
   *   拿旧光标行拽预览——必须取消；
   * - lastCursorActivityAt 归零：replaceLines 本身已被注解抑制、不再
   *   刷新该时间戳，但旧值若在 1.2s 窗口内仍会把 blocks 重建劫持进
   *   "编辑中"分支（光标行对齐）。归零确保走"非编辑"分支（顶行对齐
   *   + 去重）。
   * $effect 返回清理函数：editorApi 重建（理论场景）时自动注销旧钩子。 */
  $effect(() => {
    const api = $editorApi;
    if (!api) return;
    return api.onBeforeReplace(() => {
      cancelCursorSync();
      lastCursorActivityAt = 0;
    });
  });

  /* 面板从 display:none 恢复显示后，请求 CM 重新测量几何信息（防光标/滚动错位） */
  $effect(() => {
    const api = $editorApi;
    if ($mode !== "preview" && api) {
      requestAnimationFrame(() => api.measure());
    }
  });

  // 语言变化 → 重配 CM6 phrases
  $effect(() => {
    const api = $editorApi;
    if (api) api.setPhrases(currentLang());
  });

  /* ---------------- 启动 ---------------- */
  onMount(async () => {
    setLang(currentLang());
    // 关闭请求 → 三选确认（保存/丢弃/取消）→ ConfirmQuit（取消则无操作）。
    // 后端已启用脏状态关闭拦截（ShouldQuit + WindowClosing）：
    // 有未保存改动时后端先取消关闭，再发 close:request 到这里。
    // closeDialogOpen 防重入：对话框打开期间重复的 close:request
    // （如连续点击标题栏关闭按钮）不叠加弹窗。
    let closeDialogOpen = false;
    void onBackendEvent("close:request", async () => {
      if (closeDialogOpen) return;
      closeDialogOpen = true;
      try {
        // close:request 仅在守卫脏时由后端发出；confirm 消息仅为兜底
        const g = get(guardDirty);
        const res = await confirmDialog(
          g ? get(t)("confirm.quitDirty") : get(t)("confirm.quit"),
          g ? "dirty" : "confirm",
        );
        if (res === "cancel") return; // 中止关闭
        if (res === "save") {
          await save(); // 先保存当前文档（未命名走另存为；deleted 走确认重建）
          if (get(guardDirty)) return; // 保存未完成（另存被取消/写盘失败）→ 放弃退出
        }
        await confirmQuit(); // 丢弃，或保存成功后退出
      } finally {
        closeDialogOpen = false;
      }
    });
    // 拖拽打开（Wails File Drop 官方通道）：根元素已标 data-file-drop-target，
    // 后端 WindowFilesDropped 转发文件绝对路径 → 与对话框打开同一分流：
    // 当前实例为未命名空白文档且无编辑记录 → 原地装载；否则新实例装载。
    // 支持文件列表：首个文件走该分流，其余文件逐个拉起新实例装载。
    void onBackendEvent("file:dropped", async (d: { files?: string[] }) => {
      // 遮罩开启期间（设置面板 / confirm 弹窗 / 系统弹窗空白遮罩，与
      // 快捷键的 overlayOpen 同口径）：停止响应拖拽打开，避免遮罩交互
      // 流程未结束时装载新文档、遮罩结果与拖拽装载相互覆盖
      if (get(settingsOpen) || get(confirm$) !== null || get(dialogMask)) {
        return;
      }
      await openPaths(d?.files ?? []);
    });
    await bootApp();
  });

  // 守卫脏状态上报后端（供 WindowClosing 拦截钩子与 ShouldQuit 关闭守卫
  // 使用）：内容与干净基线不一致即拦截。窗口标题的星号标记
  // 同用 guardDirty 口径，与打开/退出的脏状态守卫保持一致
  $effect(() => {
    void reportDirty($guardDirty);
  });

  // 窗口标题与文档名同步：守卫脏状态（guardDirty）时在文档名前加星号
  // （星号与文档名以空格连接；与打开/退出的脏状态守卫同口径，见 guardDirty$）
  $effect(() => {
    const name = $docState?.name || $t("doc.untitled");
    void setTitle($guardDirty ? `* ${name}` : name);
  });

  $effect(() => {
    const onKey = (e: KeyboardEvent) => {
      const settingsOpenNow = get(settingsOpen);
      // 系统弹窗空白遮罩打开期间（Ctrl+O / Ctrl+Shift+S 等系统弹窗存续）
      // 与设置面板 / confirm 弹窗同等对待：阻断所有界面快捷键
      const dialogMaskOn = get(dialogMask);
      const overlayOpen =
        settingsOpenNow || get(confirm$) !== null || dialogMaskOn;

      /* ---- 遮罩守卫：设置面板 / confirm 弹窗 / 系统弹窗遮罩打开期间 ---- */
      if (overlayOpen) return;

      /* ---- 常规状态：文档/窗口级快捷键 ---- */
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === "n") {
        e.preventDefault();
        void spawnInstance(); // 新实例：未命名空文档
      } else if (k === "o") {
        e.preventDefault();
        void openFile();
      } else if (k === "q") {
        e.preventDefault();
        void closeWindow();
      } else if ((k === "z" || k === "y") && !e.altKey) {
        // 撤销 / 重做全局快捷键（Mod-Z / Mod-Shift-Z / Mod-Y）：
        // - 焦点在任意 CM6 实例（主编辑区 / 单元格编辑器 / 查找面板）内部
        //   → 直接跳出，由 CM6 自身 keymap 处理（主编辑区撤销编辑历史、
        //   单元格编辑器撤销单元格内容，互不串扰）；
        // - 焦点在 CM6 以外的原生输入控件（大纲筛选框等）→ 跳出，保留其
        //   自身的原生撤销语义（不劫持）；
        // - 其余焦点（预览区 / 无焦点）→ 始终由编辑区的 CM6 实例执行
        //   （编辑区组件常驻挂载，预览/源码模式下均可撤销）。
        const target = e.target instanceof Element ? e.target : null;
        if (target?.closest(".cm-editor")) return;
        if (
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          (target instanceof HTMLElement && target.isContentEditable)
        ) {
          return;
        }
        e.preventDefault();
        if (k === "z" && !e.shiftKey) get(editorApi)?.undo();
        else get(editorApi)?.redo();
      } else if (k === "s" && e.shiftKey) {
        e.preventDefault();
        void saveFileAs();
      } else if (k === "s" && !e.altKey) {
        // Ctrl/Cmd+S：全局保存兜底。CM6 聚焦时其 keymap（Mod-s）已处理并
        // preventDefault，事件冒泡到 window 时 defaultPrevented 为 true，此处
        // 跳过避免双重保存；非 CM6 聚焦状态（预览区 / 查找面板输入框 /
        // 设置面板 / 无焦点）由此触发保存。
        if (e.defaultPrevented) return;
        e.preventDefault();
        void save();
        return;
      } else if (k === "f" && !e.altKey) {
        // Ctrl/Cmd+F：全局打开查找替换面板。CM6 聚焦时其 keymap（Mod-f）已
        // 处理并 preventDefault（面板已开 → 拉取 CM6 选区；未开 → 带选区打开），
        // 事件冒泡到 window 时 defaultPrevented 为 true，此处跳过；非 CM6
        // 聚焦状态（预览区 / 无焦点）由此触发：只打开面板，不把
        // CM6 以外的选区传入关键词框；面板已开时仅聚焦，同样不做选区拉取。
        if (e.defaultPrevented) return;
        e.preventDefault();
        // 面板位于编辑区内（.cm-panels）：预览模式下编辑区 display:none，
        // 先回双栏让面板可见（保留预览滚动位置），待布局生效后再打开
        if (get(mode) === "preview") {
          setMode("split");
          requestAnimationFrame(() => get(editorApi)?.openSearch());
          return;
        }
        get(editorApi)?.openSearch();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  async function save(force = false): Promise<void> {
    // 文件已被外部移动/删除：保存路由到确认重建流程（无论是否脏——
    // 用户显式保存即意图重建文件）
    if (get(docState)?.deleted) {
      await saveDeletedDoc();
      return;
    }
    // 无路径文档（含未命名空白文档）：保存即另存为，不做脏状态静默
    // 返回——空白文档 Ctrl+S 也始终弹出另存为，保证能主动落盘
    if (!get(docState)?.path) {
      await saveFileAs();
      return;
    }
    if (!get(dirty) && !force) return; // 非脏状态静默：无修改不写后端、不弹提示
    try {
      const res = await saveDocument(get(doc), force);
      if (res.ok) {
        get(editorApi)?.markClean();
      } else if (res.conflict) {
        // 磁盘已被外部修改：确认后以当前编辑内容覆盖（confirm 模式）
        const res2 = await confirmDialog(get(t)("confirm.conflict"), "confirm");
        if (res2 === "ok") await save(true);
      }
    } catch {
      toast.set({ id: Date.now(), msg: get(t)("toast.saveFailed") });
    }
  }

  /**
   * 已删除文档的保存：弹出确认（仍然保存/取消），确认后以当前内容
   * 强制覆盖重建原路径文件（磁盘上可能已被外部更改的数据将被覆盖，
   * 用户已通过确认知悉）。取消则不做任何写盘。
   */
  async function saveDeletedDoc(): Promise<void> {
    const st = get(docState);
    if (!st?.path) return;
    const res = await confirmDialog(
      get(t)("confirm.deletedSave", { values: { path: st.path } }),
      "deletedSave",
    );
    if (res !== "save") return; // 取消：不写盘
    try {
      const r = await saveDocument(get(doc), true); // force：文件已不在磁盘，跳过冲突检测重建
      if (r.ok) {
        get(editorApi)?.markClean();
        docState.set({ ...st, deleted: false }); // 重建完成：解除删除标记
      }
    } catch {
      toast.set({ id: Date.now(), msg: get(t)("toast.saveFailed") });
    }
  }

  /**
   * 拉起新实例（Ctrl+N 快捷键与新实例装载通道共用）。
   * 仅在新进程启动失败时提示。
   */
  async function spawnInstance(path = ""): Promise<void> {
    try {
      await newInstance(path);
    } catch {
      toast.set({ id: Date.now(), msg: get(t)("toast.newInstanceFailed") });
    }
  }

  /**
   * 原地装载判定：当前实例为未命名空白文档且无编辑操作记录
   * （docState 无路径 + 内容 trim 为空）。此状态下打开
   * 不会覆盖任何内容，无需确认弹窗，直接在当前实例装载。
   */
  function canOpenInPlace(): boolean {
    const s = get(docState);
    return (!s || !s.path) && get(doc).trim() === "";
  }

  /**
   * 打开文档统一分流：未命名空白文档且无编辑记录 → 当前实例原地装载；
   * 否则 → 新实例装载（当前窗口不受影响）。
   */
  async function openPath(path: string): Promise<void> {
    if (!canOpenInPlace()) {
      await spawnInstance(path);
      return;
    }
    try {
      const state = await openDocument(path);
      if (state) loadOpenedDoc(state); // null = 二进制文件，静默丢弃
    } catch {
      toast.set({ id: Date.now(), msg: get(t)("toast.openFailed") });
    }
  }

  /** 打开文档：对话框选路径（可多选）→ 统一分流（原地 / 新实例） */
  async function openFile(): Promise<void> {
    const paths = await pickOpenPaths();
    if (!paths.length) return; // 用户取消
    await openPaths(paths);
  }

  /**
   * 打开文档列表统一分流（对话框多选 / 拖拽多文件 / 启动命令行文件列表
   * 共用）：首个文件走原有分流（未命名空白文档且无编辑记录 → 当前实例
   * 原地装载；否则新实例装载），其余文件逐个拉起新实例装载（每文件一
   * 窗口，与打开对话框的单窗口单文档模型一致）。
   */
  async function openPaths(paths: string[]): Promise<void> {
    const valid = paths.filter((p) => !!p);
    if (!valid.length) return;
    const [first, ...rest] = valid;
    await openPath(first);
    for (const p of rest) {
      await spawnInstance(p);
    }
  }

  /* ---------------- 同步滚动（带程序化滚动抑制 + 光标同步待办，防止回环与丢事件） ----------------
     两个抑制标记按"方向"拆分：
       editorProgrammaticUntil  —— 编辑器被程序化滚动（预览→编辑器回写 / 大纲跳转 /
                                   底部同步）时写；供 onEditorTopLine 与 trySyncCursor 使用，
                                   表示"编辑器滚动不是用户滚动"。
       previewProgrammaticUntil —— 预览被程序化滚动（编辑器→预览同步）时写；供
                                   onPreviewVisible 使用，表示"预览可见性变化不是用户滚动"。
     光标同步改成"pending 待办 + 幂等 trySyncCursor + 多点重试"：
       - onEditorCursorLine 只记录 + 调度 rAF，不直接做重活；
       - trySyncCursor 条件不具备时保留 pending，不丢事件；被编辑器程序化滚动
         抑制时延迟重试（340ms，覆盖 320ms 抑制窗口）；
       - blocks 更新 / previewApi 就绪 / 切回 split 均会重试，覆盖 500ms 解析滞后。
     两条路径的锚点冲突（"跳转后又跳回去"）：
       编辑中（近期有光标活动）blocks 重建后用光标行重新对齐，而不是顶行——
       顶行锚定在视窗顶部，光标锚定在 35%/65%，若 blocks 重建用顶行对齐会把
       预览从光标位置拉回顶部。非编辑（滚动查看）才用顶行对齐。
     去重策略（修复"重复插入后预览冻结同步"）：
       两条路径都不再维护"上次同步目标"记录（lastSyncedBlock/lastSyncedY，
       已删除），改为把目标落点与预览【当前实际 scrollTop】比对——记录式
       去重的隐含前提"目标相同 = 已在原地"不成立：预览实际位置随时会被
       用户滚动或顶行同步改写，而 blocks 防抖期间光标行估计 y 是不变量，
       记录命中会连 pending 一起销毁，断掉自愈路径导致永久冻结。 */
  let editorProgrammaticUntil = 0;
  let previewProgrammaticUntil = 0;

  // 光标同步待办（null 表示无待办）。rAF 合并：仅保留最后一次光标行
  let pendingCursorLine: number | null = null;
  let cursorSyncRaf = 0;
  let cursorRetryTimer = 0;

  // 最近光标活动（行 + 时间戳）：供 blocks 重建后判断是否处于编辑中，
  // 编辑中改用光标行重新对齐（避免顶行对齐造成"跳回去"）
  let lastCursorLine = 0;
  let lastCursorActivityAt = 0;

  // 最近一次同步滚动目标（块索引 + 块内像素 y），供两条路径去重
  let lastSyncedBlock = -1;
  let lastSyncedY = -1;

  // 可见性滞回带：视窗上下边缘 15%（上限 48px）内视为已可见，不干预
  function visibleMargin(vh: number): number {
    return Math.min(48, vh * 0.15);
  }

  function scrollToPreview(index: number): void {
    previewProgrammaticUntil = performance.now() + 320;
    try {
      $previewApi?.scrollToIndex(index, { offset: SYNC_OFFSET });
    } catch {
      /* ignore */
    }
  }

  function scrollToEditor(line: number): void {
    editorProgrammaticUntil = performance.now() + 320;
    $editorApi?.scrollToLine(line);
  }

  /* ---------------- 光标同步：pending + 幂等重试 ---------------- */

  /** 记录光标行并调度一次 rAF 同步（不做重活，合并快速连续移动） */
  function onEditorCursorLine(line: number): void {
    lastCursorLine = line;
    lastCursorActivityAt = performance.now();
    pendingCursorLine = line;
    scheduleCursorSync();
  }

  function scheduleCursorSync(): void {
    if (cursorSyncRaf) return;
    cursorSyncRaf = requestAnimationFrame(() => {
      cursorSyncRaf = 0;
      trySyncCursor();
    });
  }

  function cancelCursorSync(): void {
    pendingCursorLine = null;
    if (cursorSyncRaf) {
      cancelAnimationFrame(cursorSyncRaf);
      cursorSyncRaf = 0;
    }
    if (cursorRetryTimer) {
      clearTimeout(cursorRetryTimer);
      cursorRetryTimer = 0;
    }
  }

  /**
   * 尝试把 pendingCursorLine 同步到预览（幂等）：
   *   - 成功 / 判定已可见 → 清空 pending；
   *   - 条件不具备（非 split、api 未就绪、blocks 未覆盖该行）→ 保留 pending，
   *     等外部触发（blocks 更新 / api 就绪 / 切回 split）再试；
   *   - 编辑器程序化滚动抑制中 → 保留 pending，延迟 340ms 重试（覆盖 320ms
   *     抑制窗口，避免抑制期间的光标同步永久丢失）。
   * 用"光标行在预览中的估计像素 y"判可见（而非块交集），长块内光标
   * 走到块底时也会触发；可见判定带滞回带（visibleMargin）避免边缘抖动。
   */
  function trySyncCursor(): void {
    const line = pendingCursorLine;
    if (line == null) return;
    if (get(mode) !== "split") return; // 保留：切回 split 再试
    // 编辑器被程序化滚动期间（预览→编辑器回写 / 大纲跳转）光标事件让位；
    // 延迟重试，等抑制过期后再评估，避免 pending 卡住
    if (performance.now() < editorProgrammaticUntil) {
      if (!cursorRetryTimer) {
        cursorRetryTimer = window.setTimeout(() => {
          cursorRetryTimer = 0;
          scheduleCursorSync();
        }, 340);
      }
      return;
    }

    const pv = $previewApi;
    const el = pvScrollEl();
    if (!pv || !el || el.clientHeight === 0) return; // 保留：等 ready / 布局
    const bks = get(blocks);
    if (bks.length === 0) return; // 保留：等首次解析
    const lastBlk = bks[bks.length - 1];
    if (!lastBlk || line > lastBlk.endLine) return; // 保留：blocks 尚未覆盖新行

    const b = indexOfLine(line);
    if (b < 0 || b >= bks.length) return;
    const blk = bks[b];
    if (!blk) return;

    const off = pv.getItemOffset(b);
    const size = Math.max(1, pv.getItemSize(b));
    const rows = Math.max(1, blk.endLine - blk.startLine);
    const frac = Math.min(1, Math.max(0, (line - blk.startLine) / rows));
    const y = off + frac * size; // 光标行估计 y

    const top = pv.getScrollTop();
    const vh = el.clientHeight;
    const margin = visibleMargin(vh);

    // 光标行已在视窗内（扣除滞回带）→ 完成，不干预用户滚动
    if (y >= top + margin && y <= top + vh - margin) {
      pendingCursorLine = null;
      return;
    }

    // 目标位置：从上方进入 → 落在视窗 35%；从下方进入 → 落在 65%
    const targetY = y < top + margin ? y - vh * 0.35 : y - vh * 0.65;
    const target = Math.max(0, targetY);

    // 与预览【当前实际位置】比对（而非历史记录）：预览被用户滚动或
    // 顶行同步挪走后，实际位置与目标必然拉开 ≥8px，不会再把
    // "估计值未变"误判为"已同步"（原记录式去重的冻结根因）
    if (Math.abs(el.scrollTop - target) < 8) {
      pendingCursorLine = null;
      return;
    }

    outlineAutoTrack.set(true);
    topIndex.set(b);
    el.scrollTop = target;
    previewProgrammaticUntil = performance.now() + 320; // 抑制预览回写
    pendingCursorLine = null; // 完成
  }

  /* ---------------- 顶行同步（编辑器滚动 → 预览） ---------------- */
  function onEditorTopLine(line: number): void {
    if (performance.now() < editorProgrammaticUntil) return;
    // 刚发生插入/编辑（光标同步待办未消化）：顶行上报让位本轮光标同步。
    // 覆盖 insertText/Tab 的 scrollIntoView 落点及其测量修正第二跳——
    // 这些事件携带中间态顶行，以顶行锚定回写会把预览从光标落点拽开
    if (pendingCursorLine != null) return;
    const bks = get(blocks);
    if (get(mode) === "source" || bks.length === 0) return;
    const pv = $previewApi;
    if (!pv) return;
    // 编辑器是滚动源：顶行 L → 所在块 b + 块内行进度 frac →
    // 预览 scrollTop = offset(b) + frac×size(b) - SYNC_OFFSET（块内线性插值）
    const b = indexOfLine(line);
    const blk = bks[b];
    if (!blk) return;
    const rows = Math.max(1, blk.endLine - blk.startLine);
    const frac = Math.min(1, Math.max(0, (line - blk.startLine) / rows));
    const y = pv.getItemOffset(b) + frac * pv.getItemSize(b);
    const target = Math.max(0, y - SYNC_OFFSET);

    // 与预览当前实际位置比对：已同步则跳过（防止与光标路径互相覆盖抖动）
    const el = pvScrollEl();
    if (el && Math.abs(el.scrollTop - target) < 8) return;

    outlineAutoTrack.set(true);
    topIndex.set(b);
    if (el) el.scrollTop = target;
    previewProgrammaticUntil = performance.now() + 320;
  }

  /* 编辑区内容变化 → blocks 重建（500ms 防抖解析后）→ 块偏移可能整体
     变化，需要重新对齐预览。不回环：此处只写预览滚动位置，预览侧回写
     被 previewProgrammaticUntil 抑制；且必须等 blocks 就绪，过早执行
     会按旧块数据算偏移。

     锚点选择（修复"跳转后又跳回去"）：
       - 编辑中（近期有光标活动）：用光标行重新对齐。光标是编辑意图锚点，
         锚定在视窗 35%/65%；若此处改用顶行对齐（锚定在视窗顶部），预览
         会从光标位置向上跳回顶部——打字时反复"跳过去又跳回来"。
       - 非编辑（滚动查看）：按编辑器当前顶行对齐（块偏移变化后重新对齐），
         保持与用户滚动一致的顶行锚定。 */
  let blocksSeen = false;
  $effect(() => {
    const bks = $blocks;
    if (!blocksSeen) {
      blocksSeen = true;
      return;
    }
    if (bks.length === 0 || get(mode) === "source") return;
    const api = $editorApi;
    if (!api) return;

    const now = performance.now();
    if (now - lastCursorActivityAt < 1200 && lastCursorActivityAt > 0) {
      // 编辑中：用光标行重新对齐（trySyncCursor 内部处理抑制重试与可见性判定）
      if (pendingCursorLine == null) {
        pendingCursorLine = lastCursorLine;
      }
      trySyncCursor();
      return;
    }

    // 非编辑：抑制中跳过顶行对齐（避免程序化滚动期间覆盖回写结果）
    if (performance.now() < editorProgrammaticUntil) return;

    // 优先处理 pending 光标同步（编辑意图比滚动锚更精确）
    if (pendingCursorLine != null) {
      trySyncCursor();
      if (pendingCursorLine == null) return; // 已处理完，不再顶行对齐
    }
    onEditorTopLine(api.getTopLine());
  });

  /* previewApi 就绪 → 补做 pending 光标同步（首屏 / 重载后 api 晚到时兜底） */
  $effect(() => {
    if ($previewApi) scheduleCursorSync();
  });

  /** 预览滚动容器（App 侧直接驱动像素同步） */
  function pvScrollEl(): HTMLElement | null {
    return document.querySelector<HTMLElement>(".preview-scroll");
  }

  function onPreviewVisible(index: number, atBottom: boolean): void {
    // 程序滚动（编辑器→预览 / 大纲跳转）期间不回写
    if (performance.now() < previewProgrammaticUntil) return;
    // 非抑制状态下的滚动是用户滚动：清空 pending 光标同步，避免紧随的
    // 光标事件把预览从用户滚动位置拉回
    cancelCursorSync();

    const bks = get(blocks);

    // 预览已到底：编辑器同步到底（块对齐会让编辑器停在末块顶部）
    if (atBottom) {
      outlineAutoTrack.set(true);
      topIndex.set(bks.length - 1);
      scrollToEditorBottom();
      return;
    }
    const blk = get(blocks)[index];
    if (!blk) return;
    const pv = $previewApi;
    if (!pv) return;
    // 预览是滚动源：顶部块 b + 块内像素进度 → 编辑器小数行号（块内插值）
    const off = pv.getItemOffset(index);
    const size = Math.max(1, pv.getItemSize(index));
    const frac = Math.min(
      1,
      Math.max(0, (pv.getScrollTop() - off + SYNC_OFFSET) / size),
    );
    const rows = Math.max(1, blk.endLine - blk.startLine);
    outlineAutoTrack.set(true);
    topIndex.set(index);
    if ($mode !== "split") return;
    editorProgrammaticUntil = performance.now() + 320;
    $editorApi?.scrollToFractionalLine(blk.startLine + frac * rows);
  }

  function scrollToEditorBottom(): void {
    if ($mode !== "split") return;
    editorProgrammaticUntil = performance.now() + 320;
    $editorApi?.scrollToBottom();
  }

  function jumpTo(item: OutlineItem): void {
    outlineAutoTrack.set(false); // 手动点击：大纲不追踪（该项本就在视野内）
    topIndex.set(item.blockIndex);
    // 手动跳转优先：清空 pending 光标同步，避免把预览从大纲目标拉回光标处
    cancelCursorSync();
    scrollToEditor(item.line);
    scrollToPreview(item.blockIndex);
  }

  /* ---- 模式切换时保留预览滚动位置（display:none 会清零，需手动保存/恢复） ---- */
  let pvSavedTop = 0;
  function setMode(m: Mode): void {
    if ($mode === "split" || $mode === "preview") {
      pvSavedTop = $previewApi?.getScrollTop() ?? pvSavedTop;
    }
    mode.set(m);
  }
  $effect(() => {
    const m = $mode;
    // 切回 split 且存在未完成的光标同步：优先补做（用户编辑意图优先于
    // 滚动位置恢复）
    if (m === "split" && pendingCursorLine != null) {
      scheduleCursorSync();
      return;
    }
    if ((m === "split" || m === "preview") && pvSavedTop > 0) {
      const top = pvSavedTop;
      requestAnimationFrame(() => $previewApi?.setScrollTop(top));
    }
  });
  // 文档路径变化（原地打开 / 横幅重新加载）→ 丢弃保存的预览滚动位置：
  // 新文档从顶部开始，模式切换恢复逻辑不得把旧文档位置带回新文档
  let pvSavedForPath: string | null = null;
  $effect(() => {
    const p = $docState?.path ?? null;
    if (p !== pvSavedForPath) {
      pvSavedForPath = p;
      pvSavedTop = 0;
      // 新文档：清空上一文档残留的光标同步待办、重试计时
      cancelCursorSync();
      lastCursorLine = 0;
      lastCursorActivityAt = 0;
    }
  });

  /* ---------------- 分隔线拖拽（双栏比例；大纲宽度固定，不提供重布局） ---------------- */
  let dragKind = $state<"none" | "split">("none");
  let contentEl = $state<HTMLElement | null>(null);

  /* 编辑区最小宽度（px）：查找/替换面板的网格布局（两行输入 + 按钮组 +
     计数 + 关闭）完整排布约需 300px，取整留余量。极窄窗口下不再把面板
     挤成一团（输入框 min-width: 60px 只是下限，网格列仍会互相挤压） */
  const EDITOR_MIN_WIDTH_PX = 320;

  /** 双栏比例钳制：编辑区宽度 ≥ EDITOR_MIN_WIDTH_PX（按内容区宽度换算
      百分比；极窄窗口下最多占 90%，预览保底 10%），常规窗口上限仍 80% */
  function clampSplitPct(pct: number, width: number): number {
    const minPct = Math.min((EDITOR_MIN_WIDTH_PX / width) * 100, 90);
    return Math.min(Math.max(80, minPct), Math.max(minPct, pct));
  }

  function startSplitDrag(e: PointerEvent): void {
    e.preventDefault();
    const rect = contentEl?.getBoundingClientRect();
    if (!rect) return;
    dragKind = "split";
    const move = (ev: PointerEvent): void => {
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      splitPct = clampSplitPct(pct, rect.width);
    };
    const up = (): void => {
      dragKind = "none";
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  // splitPct：仅拖拽/双击重置使用的局部布局比例（不放全局 store）
  let splitPct = $state(50);
</script>

<!-- 全窗口放置区（Wails File Drop）：data-file-drop-target 由 Wails 运行时识别，
     文件悬停时自动添加 file-drop-target-active 类（样式见 app.css） -->
<div
  id="app-root"
  class="app flex h-full flex-col bg-app text-fg"
  data-file-drop-target
>
  {#if $ready}
    <!-- 顶部横幅：外部修改/删除事件响应。位于大纲、编辑、预览三者上方，
         正常文档流挤压三者高度（背景与大纲/底栏一致，见 Banner.svelte） -->
    <Banner />
    <main
      class="main relative flex min-h-0 flex-1 overflow-hidden"
      data-mode={$mode}
    >
      {#if $outlineOpen}
        <OutlinePanel
          items={$outline}
          activeLine={$activeHeading?.line ?? -1}
          autoTrack={$outlineAutoTrack}
          onSelect={jumpTo}
          onClose={() => outlineOpen.set(false)}
        />
      {/if}

      <!-- 内容区：两个面板始终挂载（CSS 控制显隐），模式切换不销毁组件 -->
      <div
        class="content flex min-w-0 flex-1 overflow-hidden"
        bind:this={contentEl}
      >
        <CodePane
          initialDoc={$doc}
          initialIndent={indentUnit[$indent]}
          lang={currentLang()}
          pct={$mode === "split" ? splitPct : null}
          onready={(api: EditorApi) => editorApi.set(api)}
          onchange={(v: string) => doc.set(v)}
          onsave={() => void save()}
          ontopline={onEditorTopLine}
          oncursorline={onEditorCursorLine}
        />

        {#if $mode === "split"}
          <!-- 分隔线：编辑器 ↔ 预览 -->
          <div
            class="divider"
            class:dragging={dragKind === "split"}
            role="separator"
            aria-orientation="vertical"
            aria-label="拖拽调整比例，双击重置等分"
            onpointerdown={startSplitDrag}
            ondblclick={() => {
              // 双击重置等分（同样受最小宽度钳制：极窄窗口下等分不成立）
              const r = contentEl?.getBoundingClientRect();
              if (r) splitPct = clampSplitPct(50, r.width);
            }}
          ></div>
        {/if}

        <PreviewPane
          segments={$segments}
          onready={(api: PreviewApi) => previewApi.set(api)}
          onvisible={onPreviewVisible}
        />
      </div>
    </main>
  {:else}
    <main class="main"><div class="boot-loading">…</div></main>
  {/if}

  <SettingsModal />

  <ConfirmDialog />

  <Toast />

  <ContextMenu />

  <BottomBar />
</div>
