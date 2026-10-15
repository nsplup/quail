<script lang="ts">
  import { onMount } from "svelte";
  import CodePane from "./lib/editor/CodePane.svelte";
  import PreviewPane from "./lib/preview/PreviewPane.svelte";
  import BottomBar from "./components/BottomBar.svelte";
  import OutlinePanel from "./components/OutlinePanel.svelte";
  import SettingsModal from "./components/SettingsModal.svelte";
  import { applyThemeVars, buildFontChain, EDITOR_FONT_FALLBACK, PREVIEW_FONT_FALLBACK } from "./lib/themes";
  import Toast from "./components/Toast.svelte";
  import ConfirmDialog from "./components/ConfirmDialog.svelte";
  import Banner from "./components/Banner.svelte";
  import {
    saveDocument,
    confirmQuit,
    onBackendEvent,
    reportDirty,
    pickOpenPath,
    openDocument,
    newInstance,
    closeWindow,
    setTitle,
  } from "./lib/bridge";
  import { confirmDialog } from "./lib/confirm";
  import {
    mode$ as mode,
    theme$ as theme,
    indent$ as indent,
    settingsOpen$ as settingsOpen,
    settingsSubPage$ as settingsSubPage,
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
    countLabel$ as countLabel,
    dirty$ as dirty,
    edited$ as edited,
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

  const indentUnit: Record<string, string> = { tab: "\t", space2: "  ", space4: "    " };
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
        $fontSizePv
      );
      $editorApi?.requestMeasure();
    }
  });

  /* 缩进单位变化 → 动态重配置编辑器（Compartment，无需重建） */
  $effect(() => {
    const api = $editorApi;
    if (api) api.setIndentUnit(indentUnit[$indent]);
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
          g ? "dirty" : "confirm"
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
    void onBackendEvent("file:dropped", async (d: { files?: string[] }) => {
      const path = d?.files?.find((p) => !!p);
      if (!path) return;
      await openPath(path);
    });
    await bootApp();
  });

  // 守卫脏状态上报后端（供 WindowClosing 拦截钩子与 ShouldQuit 关闭守卫
  // 使用）：未命名空文档在无编辑操作记录时不拦截，故上报 guardDirty 而非
  // 指示器用的 dirty
  $effect(() => {
    void reportDirty($guardDirty);
  });

  // 窗口标题与文档名同步
  $effect(() => {
    void setTitle($docState?.name || $t("doc.untitled"));
  });

  // 全局快捷键：Ctrl/Cmd+N 新实例、Ctrl/Cmd+O 新实例中打开、
  // Ctrl/Cmd+Q 退出（等同窗口关闭，触发脏状态守卫）、Ctrl/Cmd+Shift+S 另存为
  $effect(() => {
    const onKey = (e: KeyboardEvent) => {
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
      } else if (k === "s" && e.shiftKey) {
        e.preventDefault();
        void saveFileAs();
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
    if (!get(dirty) && !force) return; // 非脏状态静默：无修改不写后端、不弹提示
    if (!get(docState)?.path) {
      await saveFileAs(); // 未命名文档：保存即另存为，落盘后标题随文档名更新
      return;
    }
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
      "deletedSave"
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
   * （docState 无路径 + 内容 trim 为空 + edited 基线干净）。此状态下打开
   * 不会覆盖任何内容，无需确认弹窗，直接在当前实例装载。
   */
  function canOpenInPlace(): boolean {
    const s = get(docState);
    return (!s || !s.path) && get(doc).trim() === "" && !get(edited);
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

  /** 打开文档：对话框选路径 → 统一分流（原地 / 新实例） */
  async function openFile(): Promise<void> {
    const path = await pickOpenPath();
    if (!path) return; // 用户取消
    await openPath(path);
  }

  /* 装载（loadOpenedDoc）与另存为（saveFileAs）移至 lib/stores：
     横幅「重新加载 / 另存为」动作与原地打开通道共用同一实现 */

  /* ---------------- 同步滚动（带程序化滚动抑制，防止回环） ---------------- */
  let editorProgrammaticUntil = 0;
  let previewProgrammaticUntil = 0;

  function scrollToPreview(index: number): void {
    previewProgrammaticUntil = performance.now() + 320;
    try {
      $previewApi?.scrollToIndex(index, { offset: SYNC_OFFSET });
    } catch { /* ignore */ }
  }

  function scrollToEditor(line: number): void {
    editorProgrammaticUntil = performance.now() + 320;
    $editorApi?.scrollToLine(line);
  }

  /* 编辑区内容变化 → blocks 重建（500ms 防抖解析后）→ 块偏移可能整体
     变化，按编辑器当前顶行重新对齐预览。不回环：此处只写预览滚动位置，
     预览侧回写被 previewProgrammaticUntil 抑制；且必须等 blocks 就绪，
     过早执行会按旧块数据算偏移。 */
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
    if (performance.now() < editorProgrammaticUntil) return;
    onEditorTopLine(api.getTopLine());
  });

  function onEditorTopLine(line: number): void {
    if (performance.now() < editorProgrammaticUntil) return;
    const bks = get(blocks);
    if (get(mode) === "source" || bks.length === 0) return;
    const pv = $previewApi;
    if (!pv) return;
    // 编辑器是滚动源：顶行 L → 所在块 b + 块内行进度 frac →
    // 预览 scrollTop = offset(b) + frac×size(b) - SYNC_OFFSET（块内线性插值）
    const b = indexOfLine(line);
    const blk = get(blocks)[b];
    if (!blk) return;
    const rows = Math.max(1, blk.endLine - blk.startLine);
    const frac = Math.min(1, Math.max(0, (line - blk.startLine) / rows));
    const target = pv.getItemOffset(b) + frac * pv.getItemSize(b) - SYNC_OFFSET;
    outlineAutoTrack.set(true);
    topIndex.set(b);
    const el = pvScrollEl();
    if (el) el.scrollTop = Math.max(0, target);
    previewProgrammaticUntil = performance.now() + 320;
  }

  /** 预览滚动容器（App 侧直接驱动像素同步） */
  function pvScrollEl(): HTMLElement | null {
    return document.querySelector<HTMLElement>(".preview-scroll");
  }

  function onPreviewVisible(index: number, atBottom: boolean): void {
    // 程序滚动（编辑器→预览 / 大纲跳转）期间不回写
    if (performance.now() < previewProgrammaticUntil) return;
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
    const frac = Math.min(1, Math.max(0, (pv.getScrollTop() - off + SYNC_OFFSET) / size));
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
    }
  });

  /* ---------------- 分隔线拖拽（双栏比例；大纲宽度固定，不提供重布局） ---------------- */
  let dragKind = $state<"none" | "split">("none");
  let contentEl = $state<HTMLElement | null>(null);

  function startSplitDrag(e: PointerEvent): void {
    e.preventDefault();
    const rect = contentEl?.getBoundingClientRect();
    if (!rect) return;
    dragKind = "split";
    const move = (ev: PointerEvent): void => {
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      splitPct = Math.min(80, Math.max(20, pct));
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

  function onKeydown(e: KeyboardEvent): void {
    // Ctrl/Cmd+S：全局保存兜底。CM6 聚焦时其 keymap（Mod-s）已处理并
    // preventDefault，事件冒泡到 window 时 defaultPrevented 为 true，此处
    // 跳过避免双重保存；非 CM6 聚焦状态（预览区 / 查找面板输入框 /
    // 设置面板 / 无焦点）由此触发保存。
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") {
      if (e.defaultPrevented) return;
      e.preventDefault();
      void save();
      return;
    }
    if (e.key === "Escape") {
      // 二级页面先返回一级页面，再关闭设置面板
      if ($settingsOpen && $settingsSubPage) {
        settingsSubPage.set(null);
        return;
      }
      if ($settingsOpen) settingsOpen.set(false);
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

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
      <div class="content flex min-w-0 flex-1 overflow-hidden" bind:this={contentEl}>
        <CodePane
          initialDoc={$doc}
          initialIndent={indentUnit[$indent]}
          lang={currentLang()}
          pct={$mode === "split" ? splitPct : null}
          onready={(api: EditorApi) => editorApi.set(api)}
          onchange={(v: string) => doc.set(v)}
          onsave={() => void save()}
          ontopline={onEditorTopLine}
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
            ondblclick={() => (splitPct = 50)}
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

  <BottomBar />
</div>
