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
   *   未挂载项用 estimateSize（数值或按索引函数）估计；估计值随实测
   *   均值自适应校准（见 estSize），未测段总高尽快逼近真实值；
   * - RO 回调只记录原始尺寸，统一合帧到下一帧 rAF 应用（仍在绘制前）：
   *   RO 投递发生在渲染帧内，若在投递阶段（含微任务）同步写布局——
   *   挂载项、改定位、补偿 scrollTop——会立刻产生新的观察目标，浏览器
   *   在同一帧内反复重投递；当测量引起的范围位移恰好又挂载新项时
   *   级联加深，超出投递预算即报
   *   「ResizeObserver loop completed with undelivered notifications」。
   *   推迟到下一帧后投递循环必然收敛，警告消除；
   * - 项偏移由尺寸表前缀和实时重建（O(n)，n 为段数，量级千级可忽略）；
   * - 滚动跳动补偿：实测高度变化且项整体位于视口顶上方时，把差值同步
   *   加回 scrollTop（flush 后、绘制前执行），上行滚动加载新测量项时
   *   视口内容保持不动，估高漂移自愈；
   * - 快速滚动空窗：单帧位移超过 视口高×2（拖滚动条大幅甩动）时进入
   *   空窗——视图冻结为当前快照（不卸载、不重挂载，spacer 高度一并
   *   冻结，滚动条长度与「光标↔scrollTop」映射全程稳定），停止后
   *   40ms（≈2帧+容差）一次性按新位置回填。期间测量只记账不渲染，
   *   避免拖动中滚动条长度抖动与「回填→再卸载」的挂载抖动卡顿；
   *   滚轮/翻页/同步驱动的常规滚动（单帧 ≤1 视口高）永不触发；
   * - 滚动渲染 rAF 合帧：scroll 事件只记录位置，视口重算统一在 rAF
   *   里做，同帧多次事件至多一次 flush；
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
    /** 项 key（如大纲项取 line）：每块 DOM 复用 + 实测高度按 key 缓存。
     *  缺省按索引缓存（预览段索引稳定，增量补丁后由 ResizeObserver 自纠）。 */
    getKey?: (item: T, index: number) => unknown;
    /** 未测量项的高度估计：固定值或按索引（默认 40px） */
    estimateSize?: number | ((index: number) => number);
    /** 视口外上下各多渲染的项数 */
    overscan?: number;
    /** 单项渲染（item, index） */
    children: Snippet<[T, number]>;
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

  /* ---------------- 快速滚动空窗状态（先声明，派生与 syncData 引用） ---------------- */

  let fast = $state(false);
  let fastTimer: ReturnType<typeof setTimeout> | null = null;
  interface RenderedItem {
    i: number;
    item: T;
    key: unknown;
    top: number;
  }
  /** 空窗冻结快照：进入空窗那一刻的已渲染项数组（与 DOM 一致）。
   *  空窗期间派生原样返回该引用 → Svelte 按引用跳过 diff，零挂载/卸载；
   *  数据更换时作废（短暂空白，回填自恢复）。 */
  let frozen: RenderedItem[] | null = null;
  /** 空窗冻结的总高：spacer 高度（scrollHeight）随之冻结，拖动中
   *  滚动条长度与「光标↔scrollTop」映射保持稳定，退出时一次校正 */
  let frozenTotal = 0;

  /* ---------------- 自适应估高 ----------------
     预览段默认估计 40px 与真实段高（常见数百 px）偏差过大：拖动滚动条
     时 scrollHeight 随测量持续增长 → 滚动条 thumb 的长度/映射不断变化，
     滑块跟不上光标；跳动补偿也带着系统性偏差与原生拖动竞争（定高大纲
     项实测 ≈28.75px vs 估计 28px，逐项 0.5px+ 的偏差在快速拖动中表现为
     滑块滞后）。以已实测项的均值校准未测项估计，总高在首屏测量后即
     逼近真实值，偏差趋零。estimateSize 为按索引函数时调用方自带知识，
     不覆盖。 */
  let measuredSum = 0;
  let measuredCount = 0;
  const MEAN_MIN_SAMPLES = 4;

  function estSize(i: number): number {
    if (typeof estimateSize === "function") return estimateSize(i);
    if (measuredCount >= MEAN_MIN_SAMPLES) return measuredSum / measuredCount;
    return estimateSize;
  }

  /** data 引用变化 → 重建尺寸表（保留缓存中已有的实测值） */
  function syncData(): void {
    if (sizesFor === data) return;
    sizesFor = data;
    if (data.length === 0) {
      indexCache.clear();
      keyCache.clear();
      measuredSum = 0;
      measuredCount = 0;
    }
    frozen = null; // 数据已更换，冻结快照作废（空窗中短暂空白，回填自恢复）
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
    if (n === 0 || viewportH <= 0 || !el) {
      return { start: 0, end: -1, total };
    }
    if (fast) {
      // 空窗：范围与总高一并冻结（内容原位保留、scrollHeight 稳定），
      // 停止后由 exitFast 的 version++ 一次性按新位置回填
      return { start: 0, end: -1, total: frozenTotal };
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
    if (fast) return frozen ?? []; // 空窗：返回快照引用，Svelte 跳过 diff
    syncData();
    ensureOffsets();
    const out: RenderedItem[] = [];
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

  /* ---------------- 测量（ResizeObserver）与跳动补偿 ----------------
   * RO 回调只记录原始尺寸，统一合帧到下一帧 rAF 应用：RO 投递发生在
   * 渲染帧内，投递阶段（含微任务）的任何布局写入——挂载新项、改定位、
   * 改 spacer 高度——都会产生新的观察目标/尺寸变化，迫使浏览器在同一
   * 帧内重投递；「测量 → 范围位移 → 挂载新项 → 再测量」级联超出投递
   * 预算时即报 loop 警告。推迟到下一帧 rAF（其回调先于该帧布局/绘制
   * 执行）后，投递阶段零布局写入，投递循环必然收敛，警告消除。
   * 补偿写入随之移入 rAF 帧：flush 后、绘制前的时序不变，上行滚动
   * 仍不跳；代价仅是定位/补偿晚一帧生效，且该帧以旧尺寸自洽绘制，
   * 无可见跳动。 */

  /** 待应用测量（idx → 最新高度），同帧多条通知合帧去重 */
  const pendingMeasure = new Map<number, number>();
  let measureRaf = 0;

  function handleResize(entries: ResizeObserverEntry[]): void {
    for (const entry of entries) {
      const idx = Number((entry.target as HTMLElement).dataset.index);
      if (!Number.isInteger(idx) || idx < 0 || idx >= sizes.length) continue;
      const bbs = entry.borderBoxSize?.[0];
      const h = bbs ? bbs.blockSize : (entry.target as HTMLElement).offsetHeight;
      if (!(h > 0)) continue;
      // 亚像素抖动直接忽略：省一轮重渲染，也减少无效的待应用项。
      // 以当前生效尺寸判断，同帧重复通知以最新为准（Map 覆盖）
      if (sizes[idx] !== undefined && Math.abs(h - sizes[idx]) < 0.5) continue;
      pendingMeasure.set(idx, h);
    }
    if (pendingMeasure.size > 0 && measureRaf === 0) {
      measureRaf = requestAnimationFrame(applyMeasurements);
    }
  }

  function applyMeasurements(): void {
    measureRaf = 0;
    const c = el;
    if (!c || pendingMeasure.size === 0) return;
    const batch = new Map(pendingMeasure);
    pendingMeasure.clear();
    syncData();
    ensureOffsets();
    const st = c.scrollTop;
    const snap = offsets; // ensureOffsets 重建时会换新数组，旧引用即快照
    let delta = 0;
    let changed = false;
    for (const [idx, h] of batch) {
      if (idx >= sizes.length) continue;
      const prev = sizes[idx];
      if (Math.abs(h - prev) < 0.5) continue;
      // 首测计入自适应均值（重测不重复计入，避免图片加载等二次测量拉偏）
      let firstMeasure: boolean;
      if (getKey !== undefined) {
        const k =
          sizesFor && idx < sizesFor.length ? getKey(sizesFor[idx], idx) : undefined;
        firstMeasure = !keyCache.has(k as unknown);
      } else {
        firstMeasure = !indexCache.has(idx);
      }
      // 项整体在视口顶上方：其实测变化会推移下方全部内容 → 补偿滚动位置
      if (snap[idx] + prev <= st + 1) delta += h - prev;
      sizes[idx] = h;
      recordSize(idx, h);
      if (firstMeasure) {
        measuredSum += h;
        measuredCount++;
      }
      changed = true;
    }
    if (!changed) return;
    dirty = true;
    // 空窗中只记账不渲染：spacer/滚动条长度保持冻结（拖动中映射稳定），
    // 补偿也不写（拖动映射优先），回填时按新尺寸一次性校正
    if (fast) return;
    version++;
    // 微任务内执行：先等本帧 flush 更新项定位，再补偿 scrollTop，
    // 保证绘制前视口内容稳定（上行滚动不跳）
    if (delta !== 0) {
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
   * 快速滚动：期间视图冻结为进入空窗时的快照——不卸载、不挂载，spacer
   * 高度同步冻结（视觉为内容短暂停驻，而非空白闪烁），滚动条长度与
   * 「光标↔scrollTop」映射全程稳定。停止后下一帧一次性回填。
   * 滚轮/翻页/编辑器同步驱动的常规滚动（单帧位移通常 ≤ 1 视口高）永不
   * 触发。旧实现空窗期间卸载全部内容、每次 >40ms 停顿都整屏重挂载重型
   * 段落（变高预览卡顿的主因之一），冻结策略下挂载/卸载只发生在进出
   * 空窗各一次。关键不变量：fast 的每次状态切换都必须伴随 version++
   * （冻结态本身除外——它复用当前 DOM，无需 flush）。 */

  /* 32ms ≈ 60Hz 下 2 帧：可容忍一次单帧卡顿（约 33ms）而不产生
     「退出→挂载→再进入」抖动；滚动真正停止后回填落在下一帧，
     这是当前策略下不引入抖动的最小间隔。60Hz 以上刷新率自动更跟手。 */
  const FAST_WINDOW_MS = 40; /** 预留出容差 */
  const FAST_SCROLL_FACTOR = 2;

  /** rAF 合帧：滚动事件只记录位置，渲染统一在 rAF 里做（每帧至多一次 flush） */
  let pendingTop: number | null = null;
  let rafPending = false;
  /** 上次已应用的 scrollTop（判定单帧位移量；补偿写入后同步，避免误判快速滚动） */
  let lastAppliedTop = 0;

  function enterFast(): void {
    if (!fast) {
      // 快照当前派生（与 DOM 一致）；fast 仍为 false，读派生走常规分支
      frozen = rendered;
      ensureOffsets();
      frozenTotal = sizes.length > 0 ? offsets[sizes.length] : 0;
    }
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
    frozen = null;
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
    // 停止滚动后由定时器统一回填，避免阈值附近抖动反复挂载/卸载
    if (delta > viewportH * FAST_SCROLL_FACTOR) enterFast();
    // 空窗中视图/总高均冻结，重渲染只会解开冻结（拖动中滚动条长度抖动）；
    // version++ 统一留给 exitFast，回填在新位置一次完成
    if (!fast) version++;
  }

  /* ---------------- 容器视口尺寸 + 滚动监听 ---------------- */

  $effect(() => {
    const c = el;
    if (!c) return;
    viewportH = c.clientHeight;
    let vhRaf = 0;
    const vro = new ResizeObserver(() => {
      // 视口尺寸变化同样合帧到 rAF：RO 投递阶段内不写状态（同 handleResize），
      // 避免「状态写 → flush 改布局 → 新观察」的同帧级联
      if (vhRaf !== 0) return;
      vhRaf = requestAnimationFrame(() => {
        vhRaf = 0;
        viewportH = c.clientHeight;
      });
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
      if (vhRaf !== 0) cancelAnimationFrame(vhRaf);
      if (measureRaf !== 0) {
        cancelAnimationFrame(measureRaf);
        measureRaf = 0;
      }
      pendingMeasure.clear();
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
       virtua 一致为估计语义；绝对定位项不参与流布局，由 top 精确摆放。
       空窗期间 total 冻结为进入时的快照，保证拖动中滚动条长度/映射稳定 -->
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
