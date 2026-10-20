<script lang="ts">
  import Icon from "./Icon.svelte";
  import ParseStatus from "./ParseStatus.svelte";
  import TableInsertPopover from "./TableInsertPopover.svelte";
  import { t, locale } from "../lib/i18n.svelte";
  import type { Mode } from "../lib/types";
  import { mode$ as mode, outlineOpen$ as outlineOpen, settingsOpen$ as settingsOpen, countLabel$ as countLabel, editorApi$ as editorApi } from "../lib/stores";
  import { emptyMarkdownTable } from "../lib/markdown/table-source";

  const modes: { id: Mode; icon: string; label: string }[] = [
    { id: "source", icon: "code", label: "mode.source" },
    { id: "split", icon: "columns", label: "mode.split" },
    { id: "preview", icon: "eye", label: "mode.preview" },
  ];

  /* ---- 滑动高亮滑块：测量当前激活 tab 的几何位置，平滑跟随模式切换 ---- */
  let groupEl = $state<HTMLDivElement | null>(null);
  let thumb = $state({ left: 0, width: 0, ready: false });

  /* 表格插入浮窗开关 */
  let tableInsertOpen = $state(false);

  $effect(() => {
    // 依赖 mode 与语言（标签宽度随 i18n 文本变化；读 $t 文本建立追踪）
    const m = $mode;
    void $t(modes.find((x) => x.id === m)?.label ?? "");
    requestAnimationFrame(() => {
      const btns = groupEl?.querySelectorAll<HTMLButtonElement>(".tab");
      if (!btns || btns.length === 0) return;
      const idx = modes.findIndex((x) => x.id === m);
      const btn = btns[Math.max(0, idx)];
      if (!btn) return;
      thumb = { left: btn.offsetLeft, width: btn.offsetWidth, ready: true };
    });
  });
</script>

<footer
  class="flex h-[38px] flex-none items-center justify-between border-t border-line bg-soft px-2 select-none"
>
  <div class="flex items-center gap-1.5">
    <button
      class="icon-btn"
      class:active={false}
      title={$t("settings.title")}
      aria-label={$t("settings.title")}
      onclick={() => settingsOpen.set(true)}
    >
      <Icon name="settings" />
    </button>
    <button
      class="icon-btn"
      class:active={$outlineOpen}
      title={$t("outline.title")}
      aria-label={$t("outline.title")}
      onclick={() => outlineOpen.update((v) => !v)}
    >
      <Icon name="outline" />
    </button>

    <div
      class="relative ml-1 inline-flex items-center rounded-[10px] border border-line bg-inset p-[3px]"
      role="tablist"
      aria-label="mode"
      bind:this={groupEl}
    >
      <!-- 滑块：跟随激活 tab 平移 -->
      <div
        class="pointer-events-none absolute top-[3px] bottom-[3px] rounded-[7px] bg-active transition-[left,width] duration-200 ease-out"
        class:opacity-0={!thumb.ready}
        style="left: {thumb.left}px; width: {thumb.width}px;"
      ></div>
      {#each modes as m (m.id)}
        <button
          class="tab relative z-10"
          class:active={$mode === m.id}
          role="tab"
          aria-selected={$mode === m.id}
          title={$t(m.label)}
          onclick={() => mode.set(m.id)}
        >
          <Icon name={m.icon} size={14} />
          <span>{$t(m.label)}</span>
        </button>
      {/each}
    </div>
    <!-- 表格插入：布局切换组件右侧（与左侧的设置 / 大纲按钮对称）。
         点击弹出 9×9 行列选择浮窗，点选后在 CM6 当前光标处插入格式化的
         MARKDOWN 表格（光标落在首个表头单元格） -->
    <div class="relative flex flex-none items-center">
      <button
        class="icon-btn"
        class:active={tableInsertOpen}
        data-table-insert-toggle
        title={$t("table.insert")}
        aria-label={$t("table.insert")}
        aria-expanded={tableInsertOpen}
        onclick={() => (tableInsertOpen = !tableInsertOpen)}
      >
        <Icon name="table" size={15} />
      </button>
      {#if tableInsertOpen}
        <TableInsertPopover
          oninsert={(rows, cols) => {
            const text = emptyMarkdownTable(rows, cols);
            /* 光标落在首个表头单元格内（"| " 之后） */
            $editorApi?.insertText(text, 2);
          }}
          onclose={() => (tableInsertOpen = false)}
        />
      {/if}
    </div>
  </div>
  <!-- 右侧：字数统计 + 解析状态指示器（固定宽度，统计右侧） -->
  <div class="flex flex-none items-center gap-2 pr-1">
    <div class="bb-right truncate text-xs text-muted tabular-nums" title={$countLabel}>
      {$countLabel}
    </div>
    <ParseStatus />
  </div>
</footer>
