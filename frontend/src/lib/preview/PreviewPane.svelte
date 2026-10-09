<script lang="ts">
  /**
   * 预览面板：全量 DOM + CSS content-visibility:auto（浏览器原生虚拟化）。
   * 与虚拟列表（virtua）相比的优势：布局高度 100% 精确——
   * 拖动滚动条到底部/顶部不会因「估计高度与真实高度的差距累积」而回弹，
   * 滚动同步插值（offset/size）也基于真实布局。
   * 屏外块由浏览器跳过渲染/绘制，长文档滚动性能由 content-visibility 保障；
   * 增量渲染保留：data 按 block.id keyed，未变更块的 html 引用不变，
   * Svelte 跳过 innerHTML 写入 → 只有真正变化的块被重渲染。
   */
  import { onMount } from "svelte";
  import { attachScrollbarAutohide } from "../scrollAuto";
  import type { PreviewApi, PreviewBlock } from "../types";

  let {
    blocks,
    onready,
    onvisible,
  }: {
    blocks: PreviewBlock[];
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

  /* 滚动条自动隐藏 */
  $effect(() => {
    if (!paneEl) return;
    const el = paneEl.querySelector<HTMLElement>(".preview-scroll");
    if (!el) return;
    el.classList.add("scroll-autohide");
    return attachScrollbarAutohide(el);
  });

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
</script>

<div class="pane pane-preview" bind:this={paneEl}>
  <div
    class="preview-scroll h-full overflow-y-auto"
    onscroll={handleScroll}
    role="log"
    aria-label="preview"
  >
    <!-- 顶部间隔元素：充当预览内容的 padding-top（首块不贴顶） -->
    <div class="pv-top-pad" aria-hidden="true"></div>
    {#each blocks as block, index (block.id)}
      <div class="md-item" data-btype={block.type} data-index={index}>
        <article class="md-block">
          <!-- eslint-disable-next-line svelte/no-at-html-tags -->
          {@html block.html}
        </article>
      </div>
    {/each}
  </div>
</div>
