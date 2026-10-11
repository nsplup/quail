<script lang="ts">
  /**
   * 预览面板：原生虚拟滚动组件 VirtualList（全量 data + 按需挂载）。
   *
   * - 滚动容器由 VirtualList 根元素承担（class="preview-scroll" 维持 App 侧
   *   「按类名取滚动容器」的约定）；视口外的段不再挂载 DOM，
   *   长文档的节点数与布局成本与文档长度解耦；
   * - 不做渐进式渲染：虚拟化本身就是按需挂载（视口 ± overscan），
   *   data 直接绑定完整 segments——rAF 分批推进 visibleCount 在虚拟化下
   *   只剩 store 更新开销，且会人为延迟长文档的同步滚动/大纲可用性；
   * - 未测量/已卸载段的 offset/size 为估计值（types.ts 契约不变）：
   *   挂载段由 ResizeObserver 实测，实测结果与估计的偏差按
   *   「项整体位于视口顶上方才补偿 scrollTop」的规则消化，
   *   上行滚动与跳转后的估高漂移自愈（详见 VirtualList.svelte）；
   * - 增量渲染：worker 段级补丁 + 未变化段节点引用复用 →
   *   Svelte 跳过对应子树，只更新变化段（见 MarkdownSegment）；
   * - 滚动闪烁与渐进渲染无关（渐进仅作用于解析窗口期，滚动期间早已追平），
   *   根源是虚拟化重挂载：MarkdownImage 用模块级终态缓存 + eager 加载 +
   *   命中缓存时同步解码兜底（见该组件），本组件用较宽 overscan 预热
   *   周边项的实测高度，摊薄重挂载频率；
   * - 解析期间不渲染预览遮罩：指针/滚轮/触屏交互全程直达滚动容器。
   */
  import { onMount } from "svelte";
  import VirtualList from "../virtual/VirtualList.svelte";
  import type { VirtualListHandle } from "../virtual/VirtualList.svelte";
  import type { HastSegment } from "../markdown/markdown-core";
  import { openExternal } from "../bridge";
  import MarkdownSegment from "../markdown/MarkdownSegment.svelte";
  import type { PreviewApi } from "../types";

  let {
    segments,
    onready,
    onvisible,
  }: {
    segments: HastSegment[];
    onready: (api: PreviewApi) => void;
    /** 可视区首块变化（用于 预览→编辑器 同步滚动 与 大纲高亮）；atBottom=滚动到底 */
    onvisible: (index: number, atBottom: boolean) => void;
  } = $props();

  let paneEl = $state<HTMLDivElement | null>(null);
  /** VirtualList 实例：PreviewApi 与可视区探测的稳定入口 */
  let vlist = $state<VirtualListHandle | null>(null);
  let raf = 0;

  function scrollEl(): HTMLElement | null {
    return paneEl?.querySelector<HTMLElement>(".preview-scroll") ?? null;
  }

  /* ---------- PreviewApi：全部映射到 VirtualList handle ---------- */

  $effect(() => {
    onready({
      scrollToIndex(index, opts) {
        if (!vlist || segments.length === 0) return;
        vlist.scrollToIndex(Math.max(0, Math.min(index, segments.length - 1)), {
          align: "start",
          // 与原 virtua 映射语义一致：scrollTop = 段顶 - offset
          // （段顶落在视口顶部下方 offset px）。跳转后视口上方各段的
          // 实测修正由组件的滚动补偿消化，估计漂移可自愈。
          offset: opts?.offset ?? 0,
        });
      },
      getScrollTop() {
        return vlist?.getScrollOffset() ?? 0;
      },
      setScrollTop(top: number) {
        vlist?.scrollTo(top);
      },
      getItemOffset(index: number): number {
        if (!vlist || segments.length === 0) return 0;
        return vlist.getItemOffset(Math.max(0, Math.min(index, segments.length - 1)));
      },
      getItemSize(index: number): number {
        if (!vlist || segments.length === 0) return 0;
        return vlist.getItemSize(Math.max(0, Math.min(index, segments.length - 1)));
      },
      refresh() {
        /* 挂载段经 ResizeObserver 自适应实测，偏移表惰性重算；保留 API 兼容 */
        vlist?.refresh();
      },
    });
  });

  onMount(() => {
    // 浏览器 reload 会异步恢复子容器滚动位置；统一归零
    const zero = (): void => {
      const el = scrollEl();
      if (el) el.scrollTop = 0;
    };
    zero();
    const t = setTimeout(zero, 250);

    // 预览区链接点击统一拦截 → 后端转发系统浏览器打开；
    // 与 md-image 相同的模式：资源/动作一律交给 Go 侧处理。
    // （事件委托到虚拟滚动根元素：透传属性不含事件，改为手动挂载）
    const el = scrollEl();
    el?.addEventListener("click", handlePreviewClick);

    return () => {
      clearTimeout(t);
      el?.removeEventListener("click", handlePreviewClick);
    };
  });

  async function handlePreviewClick(e: MouseEvent): Promise<void> {
    const target = e.target as HTMLElement | null;
    const anchor = target?.closest?.("a");
    if (!anchor) return;
    const href = anchor.getAttribute("href") ?? "";
    if (!href || href.startsWith("#")) return; // 文档内锚点：无对应实现，保持默认
    e.preventDefault();
    try {
      await openExternal(href);
    } catch {
      /* 后端转发失败：已阻止默认导航，避免 webview 内跳转 */
    }
  }

  /** 预览滚动 → onvisible（rAF 合并；首块索引来自组件内核二分） */
  function handleScroll(): void {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const vl = vlist;
      const el = scrollEl();
      if (!vl || !el) return;
      try {
        // atBottom 用真实滚动容器测量（scrollHeight 含尾部 45vh 缓冲，与旧行为一致）
        const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
        const idx = vl.findStartIndex();
        onvisible(Math.max(0, Math.min(idx, segments.length - 1)), atBottom);
      } catch {
        /* ignore */
      }
    });
  }
</script>

<div class="pane pane-preview" bind:this={paneEl}>
  <!-- VirtualList 根元素即滚动容器。style 追加在组件基线样式之后，
       overflow-y: scroll 覆盖默认 auto，保持旧版「滚动条常驻」不跳动 -->
  <VirtualList
    bind:this={vlist}
    class="preview-scroll"
    style="overflow-y: scroll;"
    data={segments}
    overscan={10}
    onscroll={handleScroll}
    role="log"
    aria-label="preview"
  >
    {#snippet children(seg, index)}
      <MarkdownSegment {seg} {index} />
    {/snippet}
  </VirtualList>
</div>
