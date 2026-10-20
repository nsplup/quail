<script lang="ts">
  /**
   * TableInsertPopover：底栏「插入表格」按钮的行列选择浮窗。
   *
   * - 9×9 矩形阵列：悬停任意矩形时，从左上第一个矩形到该矩形之间的所有
   *   矩形以主题色高亮（对应将插入的行列范围）；
   * - 阵列下方实时提示当前悬停范围可插入的行列数量（行/列图标 + 数字）；
   * - 点击矩形 → emit insert(行数, 列数)（由底栏在 CM6 当前光标处插入
   *   格式化后的 MARKDOWN 表格）并关闭；
   * - 关闭时机：点选、外部按下、Esc。
   */
  import { onMount } from "svelte";
  import Icon from "./Icon.svelte";
  import { t } from "../lib/i18n.svelte";

  /** 阵列尺寸：9×9 */
  const MAX = 9;

  let { oninsert, onclose }: { oninsert: (rows: number, cols: number) => void; onclose: () => void } = $props();

  /** 当前悬停的行列（1-based；null = 未悬停） */
  let hover = $state<{ r: number; c: number } | null>(null);

  let rootEl = $state<HTMLDivElement | null>(null);

  onMount(() => {
    const onPointerDown = (ev: PointerEvent) => {
      const target = ev.target instanceof Node ? ev.target : null;
      if (!rootEl || !target) return;
      // 开关按钮自身不视为「外部」：避免 toggle 关闭后被 onclick 再次打开
      if (target instanceof Element && target.closest("[data-table-insert-toggle]")) return;
      if (!rootEl.contains(target)) {
        onclose();
      }
    };
    const onKeydown = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        onclose();
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeydown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeydown, true);
    };
  });

  function pick(r: number, c: number): void {
    oninsert(r, c);
    onclose();
  }
</script>

<div
  class="ti-pop absolute bottom-[calc(100%+8px)] left-0 z-[60] rounded-xl border border-line bg-soft p-2 shadow-lg"
  bind:this={rootEl}
  role="dialog"
  aria-label={$t("table.insert")}
>
  <div class="ti-grid" role="group" aria-label={$t("table.insert")} onmouseleave={() => (hover = null)}>
    {#each Array(MAX) as _, r (r)}
      {#each Array(MAX) as _, c (c)}
        <button
          class="ti-cell"
          class:on={hover !== null && r < hover.r && c < hover.c}
          type="button"
          tabindex="-1"
          aria-label="{r + 1} × {c + 1}"
          onmouseenter={() => (hover = { r: r + 1, c: c + 1 })}
          onclick={() => pick(r + 1, c + 1)}
        ></button>
      {/each}
    {/each}
  </div>
  <!-- 实时行列数量提示：固定高度占位避免出现/消失时浮窗跳动 -->
  <div class="ti-hint mt-2 flex h-5 items-center justify-center gap-1.5 text-xs text-muted tabular-nums">
    {#if hover}
      <span class="inline-flex items-center gap-1 text-fg">
        <Icon name="rows" size={13} />
        {hover.r}
      </span>
      <span class="opacity-60">×</span>
      <span class="inline-flex items-center gap-1 text-fg">
        <Icon name="cols" size={13} />
        {hover.c}
      </span>
    {/if}
  </div>
</div>
