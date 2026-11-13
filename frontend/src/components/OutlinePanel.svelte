<script lang="ts">
  import Icon from "./Icon.svelte";
  import TextInput from "./TextInput.svelte";
  import VirtualList from "../lib/virtual/VirtualList.svelte";
  import type { VirtualListHandle } from "../lib/virtual/VirtualList.svelte";
    import { t } from "../lib/i18n.svelte";
  import type { OutlineItem } from "../lib/types";

  let {
    items,
    activeLine,
    autoTrack,
    onSelect,
    onClose,
  }: {
    items: OutlineItem[];
    activeLine: number;
    /** 是否随激活项自动滚动（滚动同步驱动为 true；点击跳转后为 false，不追踪） */
    autoTrack: boolean;
    onSelect: (item: OutlineItem) => void;
    onClose: () => void;
  } = $props();

  let query = $state("");

  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) => it.text.toLowerCase().includes(q));
  });

  /* 激活项变化时让列表滚动到该项——仅当变化来自滚动同步（autoTrack），
     手动点击跳转（autoTrack=false）时不滚动。
     滚动直接驱动 DOM 容器（VirtualList 监听容器 scroll 事件重算视口，
     外部直写 scrollTop 同样生效，不经 handle 的 scrollToIndex）；
     未渲染项的位置用 VirtualList 的 getItemOffset 估计，误差可接受。 */
  let vhandle = $state<VirtualListHandle | null>(null);
  $effect(() => {
    const line = activeLine;
    const track = autoTrack;
    if (!vhandle || !track) return;
    const el = paneEl?.querySelector<HTMLElement>(".outline-scroll");
    if (!el) return;
    const idx = filtered.findIndex((it) => it.line === line);
    if (idx < 0) return;
    try {
      const target = vhandle.getItemOffset(idx);
      el.scrollTop = Math.max(0, target - 24);
    } catch {
      /* ignore */
    }
  });

  let paneEl = $state<HTMLElement | null>(null);
</script>

<!-- 停靠式大纲面板：固定宽度（不提供拖拽重布局），右缘 1px 分隔线 -->
<aside
  class="flex h-full w-[264px] flex-none flex-col border-r border-line bg-soft"
  bind:this={paneEl}
  aria-label={$t("outline.title")}
>
  <header class="flex h-10 flex-none items-center justify-between border-b border-line px-3">
    <span class="text-xs font-semibold tracking-wide text-fg">{$t("outline.title")}</span>
    <button class="icon-btn" title={$t("common.close")} aria-label={$t("common.close")} onclick={onClose}>
      <Icon name="close" />
    </button>
  </header>
  <div class="flex-none px-3 py-2">
    <TextInput
      placeholder={$t("outline.filter")}
      ariaLabel={$t("outline.title")}
      oninput={(v) => (query = v)}
      cls="w-full rounded-lg border border-line bg-inset px-2.5 py-1.5 text-xs text-fg outline-none transition-colors focus-within:border-accent"
      lineHeight="normal"
    />
  </div>
  <div class="min-h-0 flex-1">
    {#if filtered.length === 0}
      <div class="px-4 py-6 text-center text-xs text-muted">{$t("outline.empty")}</div>
    {:else}
      <!-- 长文档大纲同样走虚拟滚动。项为单行等高（≈28px，.outline-item
           上下 padding 5px + 12.5px 字号），估高即为终值，实测仅做校准；
           getKey=line：过滤后键子集变化，实测高度缓存仍按 key 命中 -->
      <VirtualList
        bind:this={vhandle}
        data={filtered}
        getKey={(it: OutlineItem) => it.line}
        estimateSize={28}
        overscan={6}
        class="outline-scroll"
        style="height: 100%"
      >
        {#snippet children(item)}
          <button
            class="outline-item depth-{item.depth}"
            class:active={item.line === activeLine}
            style="padding-left: {8 + (item.depth - 1) * 14}px"
            onclick={() => onSelect(item)}
            title={item.text}
          >
            <span class="outline-dot d{item.depth}"></span>
            <span class="outline-text">{item.text}</span>
          </button>
        {/snippet}
      </VirtualList>
    {/if}
  </div>
</aside>