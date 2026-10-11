<script lang="ts">
  /**
   * 预览面板：全量 DOM + 真实布局（offsetTop/offsetHeight 直接测量）。
   * 与虚拟列表（virtua）相比的优势：布局高度 100% 精确——
   * 拖动滚动条到底部/顶部不会因「估计高度与真实高度的差距累积」而回弹，
   * 滚动同步插值（offset/size）也基于真实布局。
   * 挂载节奏由 MarkdownRenderer 的渐进渲染控制（rAF 分批推进可见段数）；
   * 增量渲染：worker 段级补丁 + 未变化段节点引用复用 →
   * Svelte 跳过对应子树，只更新变化段。
   * 解析/渐进渲染期间显示半透明遮罩：
   * - 拦截点击/悬停/右键等指针交互，避免操作到「尚未稳定」的内容；
   * - 手动转发 wheel 到滚动容器，保持滚动可用（无滚动穿透副作用）；
   * - 触屏通过 touch-action:none + 手动转发保证滑动可用。
   */
  import { onMount } from "svelte";
  import type { HastSegment } from "../markdown/markdown-core";
  import { parsePhase$ as parsePhase } from "../stores";
  import { openExternal } from "../bridge";
  import MarkdownRenderer from "../markdown/MarkdownRenderer.svelte";
  import type { PreviewApi } from "../types";

  let {
    segments,
    epoch,
    patchHint,
    total,
    onprogress,
    onready,
    onvisible,
  }: {
    segments: HastSegment[];
    epoch: number;
    patchHint: { segStart: number; segAdded: number } | null;
    total: number;
    onprogress: (visible: number, total: number) => void;
    onready: (api: PreviewApi) => void;
    /** 可视区首块变化（用于 预览→编辑器 同步滚动 与 大纲高亮）；atBottom=滚动到底 */
    onvisible: (index: number, atBottom: boolean) => void;
  } = $props();

  let paneEl = $state<HTMLDivElement | null>(null);
  let raf = 0;

  function scrollEl(): HTMLElement | null {
    return paneEl?.querySelector<HTMLElement>(".preview-scroll") ?? null;
  }

  /** 块元素集合（live；自动排除顶部间隔元素，索引与 blocks 一致） */
  function items(el: HTMLElement): HTMLCollectionOf<HTMLElement> {
    return el.getElementsByClassName("md-item") as HTMLCollectionOf<HTMLElement>;
  }

  /** 可视区首块：按 offsetTop 二分（真实布局，O(log n)） */
  function findStartIndex(el: HTMLElement): number {
    const kids = items(el);
    const top = el.scrollTop + 4;
    let lo = 0;
    let hi = kids.length - 1;
    let res = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((kids[mid] as HTMLElement).offsetTop <= top) {
        res = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return res;
  }

  $effect(() => {
    onready({
      scrollToIndex(index, opts) {
        const el = scrollEl();
        const kids = el ? items(el) : null;
        if (!el || !kids || kids.length === 0) return;
        const i = Math.max(0, Math.min(index, kids.length - 1));
        const child = kids[i] as HTMLElement;
        el.scrollTop = Math.max(0, child.offsetTop - (opts?.offset ?? 0));
      },
      getScrollTop() {
        return scrollEl()?.scrollTop ?? 0;
      },
      setScrollTop(top: number) {
        const el = scrollEl();
        if (el) el.scrollTop = top;
      },
      getItemOffset(index: number): number {
        const el = scrollEl();
        if (!el) return 0;
        const kids = items(el);
        const i = Math.max(0, Math.min(index, kids.length - 1));
        return (kids[i] as HTMLElement)?.offsetTop ?? 0;
      },
      getItemSize(index: number): number {
        const el = scrollEl();
        if (!el) return 0;
        const kids = items(el);
        const i = Math.max(0, Math.min(index, kids.length - 1));
        return (kids[i] as HTMLElement)?.offsetHeight ?? 0;
      },
      refresh() {
        /* 真实布局无需手动重算；保留 API 兼容 */
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
    return () => clearTimeout(t);
  });

  /* 预览区链接点击统一拦截 → 后端转发系统浏览器打开；
     与 md-image 相同的模式：资源/动作一律交给 Go 侧处理 */
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

  function handleScroll(): void {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const el = scrollEl();
      if (!el) return;
      try {
        const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
        onvisible(findStartIndex(el), atBottom);
      } catch {
        /* ignore */
      }
    });
  }

  /* ---------- 遮罩：接管指针交互，仅放行滚动 ---------- */

  /** 遮罩上吞掉点击类事件，不冒泡到下面的预览内容 */
  function blockPointer(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
  }

  /** 遮罩上把 wheel 转发给滚动容器（保滚动、挡穿透） */
  function forwardWheel(e: WheelEvent): void {
    const el = scrollEl();
    if (!el) return;
    el.scrollTop += e.deltaY;
    if (e.deltaX) el.scrollLeft += e.deltaX;
    // 必须 preventDefault，避免滚到边界后触发链式滚动/整页回弹
    e.preventDefault();
  }

  /* ---------- 遮罩：触屏滑动转发 ---------- */

  let touchY = 0;

  function onTouchStart(e: TouchEvent): void {
    if (e.touches.length !== 1) return;
    touchY = e.touches[0].clientY;
  }

  function onTouchMove(e: TouchEvent): void {
    const el = scrollEl();
    if (!el || e.touches.length !== 1) return;
    const y = e.touches[0].clientY;
    const dy = touchY - y; // 手指上滑 → 内容上滚 → scrollTop 增大
    touchY = y;
    el.scrollTop += dy;
    e.preventDefault();
  }
</script>

<div class="pane pane-preview" bind:this={paneEl}>
  <div
    class="preview-scroll h-full overflow-y-scroll"
    onscroll={handleScroll}
    onclick={handlePreviewClick}
    role="log"
    aria-label="preview"
  >
    <MarkdownRenderer {segments} {epoch} {patchHint} {total} {onprogress} />
  </div>

  {#if $parsePhase !== "idle"}
    <!-- 半透明遮罩：提示解析/渐进渲染进行中。
         挡住指针交互（点击/悬停/右键/拖选），但通过手动转发保留滚动。 -->
    <div
      class="pv-overlay"
      aria-hidden="true"
      onclick={blockPointer}
      ondblclick={blockPointer}
      oncontextmenu={blockPointer}
      onwheel={forwardWheel}
      ontouchstart={onTouchStart}
      ontouchmove={onTouchMove}
    ></div>
  {/if}
</div>

<style>
  .pane-preview {
    position: relative; /* 遮罩定位基准 */
  }

  .pv-overlay {
    position: absolute;
    inset: 0;
    z-index: 20;
    background: rgba(255, 255, 255, 0.35);
    /* 关键：恢复指针命中，接管交互；滚动由 JS 手动转发 */
    pointer-events: auto;
    cursor: progress; /* 忙状态提示 */
    /* 触屏：禁用浏览器默认手势，交给 JS 转发 */
    touch-action: none;
    transition: opacity 0.12s ease;
  }
</style>
