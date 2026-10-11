<script module lang="ts">
  /**
   * VirtualList —— Svelte 原生虚拟滚动组件（替代 virtua VList，零依赖）。
   *
   * 结构：
   *   根元素（滚动容器，接收 class/style/onscroll 等 rest 属性透传）
   *     └─ 内层定位容器（height = 全部项的估计/实测高度之和）
   *          └─ 视口 ± overscan 范围内的项（绝对定位，top = 项偏移）
   *
   * 测量与定位：
   * - 每个挂载项由 ResizeObserver 实测 border-box 高度，写入尺寸表；
   *   未挂载项用 estimateSize（数值或按索引函数）估计；
   * - 项偏移由尺寸表前缀和实时重建（O(n)，n 为段数，量级千级可忽略）；
   * - 滚动跳动补偿：实测高度变化且项整体位于视口顶上方时，把差值同步
   *   加回 scrollTop（微任务内执行，DOM 定位更新后、绘制前生效），
   *   上行滚动加载新测量项时视口内容保持不动，估高漂移自愈；
   * - 快速滚动空窗：单帧位移超过 视口高×2（拖滚动条大幅甩动）时暂停
   *   挂载，只保留总高度占位，停止后 32ms（≈2帧）内回填——滚轮/翻页/
   *   同步驱动的常规滚动（单帧 ≤1 视口高）永不触发，与 CM6 行为对齐；
   * - 滚动渲染 rAF 合帧：scroll 事件只记录位置，视口重算统一在 rAF
   *   里做，同帧多次事件至多一次 flush；
   * - ResizeObserver 卫生：亚像素（<0.5px）测量变化忽略，补偿写入
   *   同步位移基线不参与空窗判定，避免「测量→写入→再测量」在同帧
   *   级联为 RO loop 警告；
   * - 项的绝对定位包装自身构成 BFC，子元素的垂直 margin 计入实测高度，
   *   不存在 margin 折叠导致的定位偏差；块间距仍建议用 padding。
   *
   * 兼容 virtua VListHandle 的核心面（本仓库两个使用方所需）：
   *   scrollToIndex / scrollTo / getScrollOffset / findStartIndex /
   *   getItemOffset / getItemSize / refresh
   * 并为大纲栏预留 getKey：过滤/重排后按 key 保留实测高度缓存，
   *   且外部直接驱动滚动容器 scrollTop（不经组件）同样可用——
   *   滚动事件驱动视口重算，getItemOffset 返回的估计偏移随时可查。
   */
  export interface VirtualListHandle {
    /** 滚动到指定项（align 默认 start；offset 为 start 对齐时的附加偏移，
     *  语义 scrollTop = 项顶 − offset） */
    scrollToIndex(
      index: number,
      opts?: { align?: "start" | "center" | "end"; offset?: number; smooth?: boolean },
    ): void;
    /** 滚动到绝对位置（像素） */
    scrollTo(top: number): void;
    /** 当前滚动位置 */
    getScrollOffset(): number;
    /** 当前视口顶部的项索引（滚动位置所在的项，二分查找） */
    findStartIndex(): number;
    /** 第 index 项的文档偏移（未测量项为估计值） */
    getItemOffset(index: number): number;
    /** 第 index 项的渲染高度（未测量项为估计值） */
    getItemSize(index: number): number;
    /** 外部布局变化后手动触发偏移重算 */
    refresh(): void;
  }
</script>

<script lang="ts" generics="T">
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";

  interface Props<T> extends HTMLAttributes<HTMLElement> {
    data: T[];
    /** 单项渲染（item, index） */
    children: Snippet<[T, number]>;
    /** 项 key（如大纲项取 line）：每块 DOM 复用 + 实测高度按 key 缓存。
     *  缺省按索引缓存（预览段索引稳定，增量补丁后由 ResizeObserver 自纠）。 */
    getKey?: (item: T, index: number) => unknown;
    /** 未测量项的高度估计：固定值或按索引（默认 40px） */
    estimateSize?: number | ((index: number) => number);
    /** 视口外上下各多渲染的项数 */
    overscan?: number;
    class?: string;
    style?: string;
  }

  let {
    data,
    children,
    getKey,
    estimateSize = 40,
    overscan = 4,
    class: className = "",
    style,
    ...rest
  }: Props<T> = $props();

  /* ---------------- 内部状态 ----------------
     sizes/offsets 为普通数组（非响应式），由 version 触发派生重算，
     避免每次测量都走深层数组响应式开销。 */

  let el = $state<HTMLElement | null>(null);
  let viewportH = $state(0);
  let version = $state(0);

  /** 项高度表（估计或实测）与偏移前缀和（offsets[i] = 第 i 项 top） */
  let sizes: number[] = [];
  let offsets: number[] = [0];
  /** sizes 当前对应的数据引用（data 换引用时重建） */
  let sizesFor: T[] | null = null;
  /** 偏移前缀和是否需要重建 */
  let dirty = true;

  /** 实测高度缓存：按索引（缺省）或按 getKey 结果 */
  const indexCache = new Map<number, number>();
  const keyCache = new Map<unknown, number>();

  function estSize(i: number): number {
    return typeof estimateSize === "function" ? estimateSize(i) : estimateSize;
  }

  /** data 引用变化 → 重建尺寸表（保留缓存中已有的实测值） */
  function syncData(): void {
    if (sizesFor === data) return;
    sizesFor = data;
    if (data.length === 0) {
      indexCache.clear();
      keyCache.clear();
    }
    const arr = new Array<number>(data.length);
    for (let i = 0; i < data.length; i++) {
      if (getKey !== undefined) {
        const k = getKey(data[i], i);
        arr[i] = keyCache.get(k) ?? estSize(i);
      } else {
        arr[i] = indexCache.get(i) ?? estSize(i);
      }
    }
    sizes = arr;
    dirty = true;
  }

  /** 重建偏移前缀和（幂等；dirty 时 O(n)） */
  function ensureOffsets(): void {
    if (!dirty) return;
    dirty = false;
    const n = sizes.length;
    offsets = new Array<number>(n + 1);
    offsets[0] = 0;
    let acc = 0;
    for (let i = 0; i < n; i++) {
      acc += sizes[i];
      offsets[i + 1] = acc;
    }
  }

  /** 最后一个 offsets[i] <= y 的项索引（视口顶部所在项） */
  function findStart(y: number): number {
    const n = sizes.length;
    if (n === 0) return 0;
    let lo = 0;
    let hi = n - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (offsets[mid] <= y) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans;
  }

  function recordSize(i: number, h: number): void {
    if (getKey !== undefined && sizesFor && i < sizesFor.length) {
      keyCache.set(getKey(sizesFor[i], i), h);
    } else {
      indexCache.set(i, h);
    }
  }

  /* ---------------- 视口计算（渲染范围） ---------------- */

  const view = $derived.by(() => {
    void version; // 滚动/测量/数据变更都通过 version 触发重算
    void viewportH;
    void fast; // 快速滚动空窗状态
    syncData();
    ensureOffsets();
    const n = data.length;
    const total = n > 0 ? offsets[n] : 0;
    if (n === 0 || viewportH <= 0 || !el || fast) {
      // fast：只保留总高度占位（滚动条长度稳定），内容停止后回填
      return { start: 0, end: -1, total };
    }
    const st = el.scrollTop;
    const first = findStart(st);
    const last = findStart(st + viewportH);
    return {
      start: Math.max(0, first - overscan),
      end: Math.min(n - 1, last + overscan),
      total,
    };
  });

  const rendered = $derived.by(() => {
    void version;
    syncData();
    ensureOffsets();
    const out: { i: number; item: T; key: unknown; top: number }[] = [];
    for (let i = view.start; i <= view.end; i++) {
      out.push({
        i,
        item: data[i],
        key: getKey !== undefined ? getKey(data[i], i) : i,
        top: offsets[i],
      });
    }
    return out;
  });

  /* ---------------- 测量（ResizeObserver）与跳动补偿 ---------------- */

  function handleResize(entries: ResizeObserverEntry[]): void {
    const c = el;
    if (!c || entries.length === 0) return;
    syncData();
    ensureOffsets();
    const st = c.scrollTop;
    const snap = offsets; // ensureOffsets 重建时会换新数组，旧引用即快照
    const prevSizes = sizes.slice();
    let delta = 0;
    let changed = false;
    for (const entry of entries) {
      const idx = Number((entry.target as HTMLElement).dataset.index);
      if (!Number.isInteger(idx) || idx < 0 || idx >= sizes.length) continue;
      const bbs = entry.borderBoxSize?.[0];
      const h = bbs ? bbs.blockSize : (entry.target as HTMLElement).offsetHeight;
      if (!(h > 0)) continue;
      const prev = prevSizes[idx];
      // 亚像素抖动直接忽略：既省一轮重渲染，也避免 ResizeObserver
      // 「测量→写入→再测量」在同帧内反复触发（loop 警告的主要来源）
      if (Math.abs(h - prev) < 0.5) continue;
      // 项整体在视口顶上方：其实测变化会推移下方全部内容 → 补偿滚动位置
      if (snap[idx] + prev <= st + 1) delta += h - prev;
      sizes[idx] = h;
      recordSize(idx, h);
      changed = true;
    }
    if (!changed) return;
    dirty = true;
    version++;
    // 微任务内执行：先等 Svelte flush 更新项定位，再补偿 scrollTop，
    // 保证绘制前视口内容稳定（上行滚动不跳）
    if (delta !== 0 && !fast) {
      queueMicrotask(() => {
        const c2 = el;
        if (!c2) return;
        c2.scrollTop = Math.max(0, c2.scrollTop + delta);
        // 同步基线：补偿写入不参与「单帧位移」判定，避免误入快速滚动空窗
        lastAppliedTop = c2.scrollTop;
        if (pendingTop !== null) pendingTop = c2.scrollTop;
      });
    }
  }

  const ro: ResizeObserver | null =
    typeof ResizeObserver === "undefined" ? null : new ResizeObserver(handleResize);

  /** 挂载项测量（observe 首次回调即完成初始实测） */
  function measure(node: HTMLElement): { destroy(): void } {
    ro?.observe(node);
    return {
      destroy() {
        ro?.unobserve(node);
      },
    };
  }

  /* ---------------- 快速滚动空窗（对齐 CM6 的行为） ----------------
   * 单帧位移超过 视口高×FAST_SCROLL_FACTOR（拖滚动条大幅甩动）才判为
   * 快速滚动：期间不挂载内容（只保留总高度占位，视觉为短暂空白），
   * 停止后下一帧回填。滚轮/翻页/编辑器同步驱动的常规滚动（单帧位移
   * 通常 ≤ 1 视口高）永不触发，与 CM6 中小文档快速滚动无空窗一致；
   * 只有重挂载成本真正压垮滚动帧率的大幅位移才让位给空窗。
   * 关键不变量：fast 的每次状态切换都必须伴随 version++，否则派生
   * 视图滞留旧状态——空窗到期不回填、程序跳转后白屏都源于此。 */

  let fast = $state(false);
  let fastTimer: ReturnType<typeof setTimeout> | null = null;
  /** rAF 合帧：滚动事件只记录位置，渲染统一在 rAF 里做（每帧至多一次 flush） */
  let pendingTop: number | null = null;
  let rafPending = false;
  /** 上次已应用的 scrollTop（判定单帧位移量；补偿写入后同步，避免误判快速滚动） */
  let lastAppliedTop = 0;

  /* 32ms ≈ 60Hz 下 2 帧：可容忍一次单帧卡顿（约 33ms）而不产生
     「退出→挂载→再进入」抖动；滚动真正停止后回填落在下一帧，
     这是当前策略下不引入抖动的最小间隔。60Hz 以上刷新率自动更跟手。 */
  const FAST_WINDOW_MS = 32;
  const FAST_SCROLL_FACTOR = 2;

  function enterFast(): void {
    fast = true;
    if (fastTimer !== null) clearTimeout(fastTimer);
    fastTimer = setTimeout(exitFast, FAST_WINDOW_MS);
  }

  /** 退出空窗（定时到期 / 程序跳转 / 卸载）：状态变化必须触发重渲染回填 */
  function exitFast(): void {
    if (fastTimer !== null) {
      clearTimeout(fastTimer);
      fastTimer = null;
    }
    if (fast) {
      fast = false;
      version++;
    }
  }

  function applyScroll(): void {
    rafPending = false;
    const c = el;
    const top = pendingTop;
    pendingTop = null;
    if (!c || top === null) return;
    const delta = Math.abs(top - lastAppliedTop);
    if (delta < 0.5) return;
    lastAppliedTop = top;
    // 达标帧续期空窗（enterFast 内重置定时器），未达标帧不打断——
    // 停止滚动后由 48ms 定时器统一回填，避免阈值附近抖动反复挂载/卸载
    if (delta > viewportH * FAST_SCROLL_FACTOR) enterFast();
    version++;
  }

  /* ---------------- 容器视口尺寸 + 滚动监听 ---------------- */

  $effect(() => {
    const c = el;
    if (!c) return;
    viewportH = c.clientHeight;
    const vro = new ResizeObserver(() => {
      viewportH = c.clientHeight;
    });
    vro.observe(c);
    // 外部（App 侧程序滚动）直接写 scrollTop 也会走这里触发视口重算；
    // rAF 合帧：同帧多次 scroll 事件只渲染一次，回填仍在绘制前完成
    const onScroll = (): void => {
      const s = c.scrollTop;
      pendingTop = s;
      if (!rafPending) {
        rafPending = true;
        requestAnimationFrame(applyScroll);
      }
    };
    c.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      exitFast();
      vro.disconnect();
      c.removeEventListener("scroll", onScroll);
    };
  });

  /* ---------------- 对外 handle（VirtualListHandle） ---------------- */

  export function scrollToIndex(
    index: number,
    opts?: { align?: "start" | "center" | "end"; offset?: number; smooth?: boolean },
  ): void {
    const c = el;
    if (!c) return;
    syncData();
    ensureOffsets();
    const n = sizes.length;
    if (n === 0) return;
    const i = Math.max(0, Math.min(index, n - 1));
    const align = opts?.align ?? "start";
    const extra = opts?.offset ?? 0;
    let top: number;
    if (align === "center") {
      top = offsets[i] + sizes[i] / 2 - viewportH / 2;
    } else if (align === "end") {
      top = offsets[i] + sizes[i] - viewportH;
    } else {
      top = offsets[i] - extra;
    }
    const max = Math.max(0, c.scrollHeight - c.clientHeight);
    const target = Math.max(0, Math.min(top, max));
    // 程序跳转：退出空窗、退出空窗后必须 version++ 强制按新位置重渲染
    // （scroll 事件因基线已对齐 delta=0 会早退，不补这一步会白屏滞留），
    // 并同步位移基线避免跳转本身被误判为快速滚动
    exitFast();
    c.scrollTo({ top: target, behavior: opts?.smooth ? "smooth" : "auto" });
    lastAppliedTop = c.scrollTop;
    pendingTop = null;
    version++;
  }

  export function scrollTo(top: number): void {
    const c = el;
    if (!c) return;
    exitFast();
    c.scrollTo({ top });
    lastAppliedTop = c.scrollTop;
    pendingTop = null;
    version++;
  }

  export function getScrollOffset(): number {
    return el?.scrollTop ?? 0;
  }

  export function findStartIndex(): number {
    syncData();
    ensureOffsets();
    return findStart(el?.scrollTop ?? 0);
  }

  export function getItemOffset(index: number): number {
    syncData();
    ensureOffsets();
    const n = sizes.length;
    if (n === 0) return 0;
    return offsets[Math.max(0, Math.min(index, n - 1))];
  }

  export function getItemSize(index: number): number {
    syncData();
    ensureOffsets();
    const n = sizes.length;
    if (n === 0) return 0;
    return sizes[Math.max(0, Math.min(index, n - 1))];
  }

  export function refresh(): void {
    dirty = true;
    version++;
  }
</script>

<!-- 根元素 = 滚动容器。内联基线样式供缺省使用，调用方 class/style
     （追加在末尾）可逐属性覆盖，如 overflow-y: scroll 保持滚动条常驻。
     overflow-anchor 关闭浏览器原生滚动锚定：估高→实测的定位修正由
     组件的 scrollTop 补偿负责，避免双重修正产生可见跳动。 -->
<div
  bind:this={el}
  {...rest}
  class={className}
  style="display: block; width: 100%; height: 100%; overflow-y: auto; overflow-anchor: none; {style ?? ''}"
>
  <!-- 内层定位容器：height 撑起全部内容（估计+实测），滚动条长度与
       virtua 一致为估计语义；绝对定位项不参与流布局，由 top 精确摆放 -->
  <div style="position: relative; width: 100%; height: {view.total}px;">
    {#each rendered as it (it.key)}
      <div
        use:measure
        data-index={it.i}
        style="position: absolute; top: {it.top}px; left: 0; width: 100%;"
      >
        {@render children(it.item, it.i)}
      </div>
    {/each}
  </div>
</div>
