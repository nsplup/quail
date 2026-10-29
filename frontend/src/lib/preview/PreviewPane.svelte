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
  import type {
    Element as HastElement,
    ElementContent as HastContent,
  } from "hast";
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
        return vlist.getItemOffset(
          Math.max(0, Math.min(index, segments.length - 1)),
        );
      },
      getItemSize(index: number): number {
        if (!vlist || segments.length === 0) return 0;
        return vlist.getItemSize(
          Math.max(0, Math.min(index, segments.length - 1)),
        );
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

  function handlePreviewClick(e: MouseEvent): void {
    const anchor = (e.target as Element | null)?.closest?.("a");
    if (!anchor) return;

    // 命中链接即阻止默认导航：href 缺失/空串时浏览器会解析为当前文档 URL 触发重载
    e.preventDefault();

    const href = anchor.getAttribute("href")?.trim() ?? "";
    if (!href) return;

    if (href.startsWith("#")) {
      scrollToAnchor(href.slice(1));
      return;
    }

    void openExternal(href);
  }

  /* ---------- 页内锚点 / 脚注跳转 ---------- */

  /** GitHub 风格 id 前缀：脚注锚（mdast-util-to-hast 产物）自带，标题锚点为裸 slug */
  const USER_CONTENT_PREFIX = "user-content-";

  /** 解码 href 片段（decodeURIComponent 容错：畸形转义原样返回） */
  function decodeAnchor(raw: string): string {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }

  /**
   * 锚点 id 候选序列（去重保序）：
   * 1. href 原文解码值——脚注链接（#user-content-fn-N）与带前缀书写的标题锚；
   * 2. 去 user-content- 前缀的裸 id——标题锚点（remark-slug 产物）的主流写法；
   * 3. 补 user-content- 前缀——文档按 GitHub 习惯书写（#hello ↔ user-content-hello）。
   */
  function anchorIdCandidates(raw: string): string[] {
    const decoded = decodeAnchor(raw);
    const bare = decoded.startsWith(USER_CONTENT_PREFIX)
      ? decoded.slice(USER_CONTENT_PREFIX.length)
      : decoded;
    return [...new Set([decoded, bare, USER_CONTENT_PREFIX + bare])].filter(
      Boolean,
    );
  }

  /** 段内深度优先查找携带目标 id 的元素（脚注定义 li 嵌在 section > ol 内，
   *  标题 id 直接落在段顶层节点上） */
  function segmentHasId(seg: HastSegment, id: string): boolean {
    const walk = (n: HastContent): boolean => {
      if (n.type !== "element") return false;
      const el = n as HastElement;
      if (typeof el.properties?.id === "string" && el.properties.id === id)
        return true;
      return el.children.some(walk);
    };
    return seg.nodes.some(walk);
  }

  /** 元素级定位：以滚动容器为基准换算绝对 scrollTop（元素可能深嵌在
   *  section/ol 内，段顶 ≠ 元素顶，故不做 scrollToIndex 兜底近似） */
  function jumpToElement(el: globalThis.Element): void {
    const container = scrollEl();
    if (!container) return;
    const cr = container.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    vlist?.scrollTo(container.scrollTop + (er.top - cr.top));
  }

  /**
   * 页内锚点跳转（虚拟滚动感知的两级定位）：
   * 1. id 候选在已挂载 DOM 中精确查询（视口内 / overscan 覆盖的常见情况），
   *    命中即元素级定位；
   * 2. 未挂载则遍历段列表找到承载该 id 的段，scrollToIndex 触发段挂载，
   *    挂载完成后（双 rAF：Svelte flush + 项布局）再元素级微调——段顶
   *    与目标元素顶不重合（脚注 li 在段内偏移）时二次修正。
   */
  function scrollToAnchor(rawId: string): void {
    for (const id of anchorIdCandidates(rawId)) {
      const mounted =
        scrollEl()?.querySelector(`[id="${CSS.escape(id)}"]`) ?? null;
      if (mounted) {
        jumpToElement(mounted);
        return;
      }
      const segIndex = segments.findIndex((s) => segmentHasId(s, id));
      if (segIndex >= 0) {
        vlist?.scrollToIndex(segIndex, { align: "start" });
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const el = scrollEl()?.querySelector(`[id="${CSS.escape(id)}"]`);
            if (el) jumpToElement(el);
          }),
        );
        return;
      }
    }
    /* 未命中任何候选：目标锚点不存在（空引用 / 增量窗口尚未解析到），
       保守不动，与浏览器「无效锚点无副作用」行为一致 */
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
