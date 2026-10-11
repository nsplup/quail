<script lang="ts">
  import Icon from "./Icon.svelte";
  import { t, locale } from "../lib/i18n.svelte";
  import type { Mode } from "../lib/types";
  import { mode$ as mode, outlineOpen$ as outlineOpen, settingsOpen$ as settingsOpen, countLabel$ as countLabel, dirty$ as dirty, parsePhase$ as parsePhase } from "../lib/stores";

  const modes: { id: Mode; icon: string; label: string }[] = [
    { id: "source", icon: "code", label: "mode.source" },
    { id: "split", icon: "columns", label: "mode.split" },
    { id: "preview", icon: "eye", label: "mode.preview" },
  ];

  /* ---- 滑动高亮滑块：测量当前激活 tab 的几何位置，平滑跟随模式切换 ---- */
  let groupEl = $state<HTMLDivElement | null>(null);
  let thumb = $state({ left: 0, width: 0, ready: false });

  $effect(() => {
    // 依赖 mode 与语言（标签宽度随 i18n 文本变化；读 $t 文本建立追踪）
    const m = $mode;
    void $t(modes.find((x) => x.id === m)?.label ?? "");
    void $dirty;
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

    <!-- 脏状态指示器：独立组件，与模式切换相邻；圆点在描述文本右侧 -->
    <div
      class="ml-2 flex flex-none items-center gap-1.5 text-xs text-muted select-none"
      title={$dirty ? $t("common.dirty") : $t("common.saved")}
      role="status"
    >
      <span>{$dirty ? $t("common.dirty") : $t("common.saved")}</span>
      <span
        class="h-2 w-2 flex-none rounded-full transition-colors duration-200"
        style:background={$dirty ? "var(--ui-warn)" : "var(--ui-ok)"}
      ></span>
    </div>
  </div>
  {#if $parsePhase !== "idle"}
    <!-- 预览解析进行中：加载动画 SVG icon（渲染随结果落地即时完成，无独立阶段） -->
    <div
      class="flex flex-none items-center gap-1.5 pr-2 text-xs text-muted select-none"
      role="status"
      title={$t("preview.parsing")}
    >
      <svg
        class="h-3.5 w-3.5 animate-spin"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
      >
        <circle
          cx="12"
          cy="12"
          r="9"
          stroke="currentColor"
          stroke-opacity="0.25"
          stroke-width="3"
        ></circle>
        <path
          d="M21 12a9 9 0 0 0-9-9"
          stroke="currentColor"
          stroke-width="3"
          stroke-linecap="round"
        ></path>
      </svg>
    </div>
  {/if}
  <div class="bb-right truncate pr-1 text-xs text-muted tabular-nums" title={$countLabel}>
    {$countLabel}
  </div>
</footer>
