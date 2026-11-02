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
   * - 解析期间不渲染预览遮罩：指针/滚轮/触屏交互全程直达滚动容器；
   * - 脚注列表（MarkdownFootnotes，只从全局 STORE 订阅）挂载为列表末尾
   *   哨兵项：随内容滚动、ResizeObserver 实测高度、onvisible 的既有
   *   clamp（对 segments.length 收口）天然兼容；
   * - 脚注跳转系统（点击委托统一拦截自定义锚）：
   *   · #fn:N（正文引用 → 列表项）：已挂载直跳元素级定位，否则滚动到
   *     哨兵项挂载后元素级修正；
   *   · #fnref:N:K（列表回链 → 第 N 个脚注的第 K 次引用出现）：以段
   *     HAST 数据为唯一事实源（虚拟化下挂载 DOM 的出现序计数不可靠），
   *     按文档序扫描定位第 K 次出现所在段与段内序 → scrollToIndex 挂载
   *     后在段容器内取对应元素精确定位——多次引用可完美跳回。
   */
  import { onMount } from "svelte";
  import VirtualList from "../virtual/VirtualList.svelte";
  import type { VirtualListHandle } from "../virtual/VirtualList.svelte";
  import type {
    Element as HastElement,
    ElementContent as HastContent,
  } from "hast";
  import type { HastSegment } from "../markdown/markdown-core";
  import { readRefProp } from "../markdown/markdown-core";
  import { openExternal } from "../bridge";
  import MarkdownSegment from "../markdown/MarkdownSegment.svelte";
  import MarkdownFootnotes from "../markdown/MarkdownFootnotes.svelte";
  import {
    footnoteList$,
    refsSnapshot$,
    footnoteNumberById$,
  } from "../markdown/reference-store";
  import type { PreviewApi } from "../types";
  import { get } from "svelte/store";
  import {
    previewSearchState$,
    flattenHastText,
    type PreviewMatchInfo,
  } from "../preview/previewSearch";

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

  /** 脚注列表哨兵项（data 末尾占位；children snippet 据此分派渲染组件） */
  const FOOTNOTES_SENTINEL = {
    type: "__footnotes__",
    nodes: [],
  } as HastSegment;
  /** 虚拟列表数据：有被引用的脚注时末尾挂哨兵项（空脚注不占位） */
  const items = $derived(
    $footnoteList$.length > 0 ? [...segments, FOOTNOTES_SENTINEL] : segments,
  );

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
        // clamp 回退到正文段：正文段下标语义不应误入脚注哨兵项
        if (!vlist || segments.length === 0) return;
        vlist.scrollToIndex(Math.max(0, Math.min(index, segments.length - 1)), {
          align: "start",
          offset: opts?.offset ?? 0,
        });
      },
      scrollToMatch(id) {
        scrollToMatch(id);
      },
      getScrollTop() {
        return vlist?.getScrollOffset() ?? 0;
      },
      setScrollTop(top: number) {
        vlist?.scrollTo(top);
      },
      getItemOffset(index) {
        if (!vlist || segments.length === 0) return 0;
        return vlist.getItemOffset(
          Math.max(0, Math.min(index, segments.length - 1)),
        );
      },
      getItemSize(index) {
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

    // 脚注自定义锚先行拦截（MarkdownFootnoteRef 的 #fn:N 与列表回链
    // #fnref:N:K），其余 # 锚走标题页内跳转；slug 不含冒号，无碰撞
    const fnJump = /^#fn:(\d+)$/.exec(href);
    if (fnJump) {
      jumpToFootnoteDef(Number(fnJump[1]));
      return;
    }
    const fnRefJump = /^#fnref:(\d+):(\d+)$/.exec(href);
    if (fnRefJump) {
      jumpToFootnoteRef(Number(fnRefJump[1]), Number(fnRefJump[2]));
      return;
    }

    if (href.startsWith("#")) {
      scrollToAnchor(href.slice(1));
      return;
    }

    void openExternal(href);
  }

  /* ---------- 页内锚点 / 脚注跳转 ---------- */

  /** GitHub 风格 id 前缀：历史文档锚点兼容候选（脚注节已改由组件渲染，
   *  前缀候选序列保留给标题锚的两种书写习惯） */
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

  /**
   * 跳转让位偏移：读查找面板高度变量 --search-panel-h
   * （面板打开时挂载于祖先节点、关闭时移除；自定义属性沿继承链解析，
   *  在滚动容器上读取即得当前值）。
   * 返回 px 数值：变量存在且为合法长度 → 数值；缺失/畸形 → 0。
   */
  function jumpOffset(): number {
    const container = scrollEl();
    if (!container) return 0;
    const raw = getComputedStyle(container)
      .getPropertyValue("--search-panel-h")
      .trim();
    const px = Number.parseFloat(raw);
    // 只接受 px 类正值；空串/非法值/负值一律 0（Number.parseFloat("abc") 为 NaN）
    return Number.isFinite(px) && px > 0 ? px : 0;
  }

  /** 跳转代数：新跳转让旧纠偏链失效（最后一次点击独占滚动权），
   *  用户手动滚动同样作废本次纠偏（见 cancel） */
  let jumpSeq = 0;

  /** 纠偏重试帧数上限（≈800ms @60Hz）：兜底异常场景（数据反复变更、
   *  图片持续加载等）防死循环；正常路径 3~5 帧内收敛 */
  const JUMP_MAX_TRIES = 48;

  /**
   * 元素级定位（估计布局感知）：以滚动容器为基准换算绝对 scrollTop。
   *
   * 为什么要循环纠偏而不是一次定位——虚拟滚动下元素坐标建立在
   * 「估计 + 局部实测」的混合布局上：传送挂载的段要在 1~2 帧后才经
   * RO→rAF 链路实测落地，横跨视口顶的段长高时其下内容（含目标）整体
   * 下移，且不满足组件「项整体位于视口顶上方才补偿 scrollTop」的条件
   * ——单点计算的目标必偏，表现为跳到目标上方几个块。逐帧从 live rect
   * 重算并滚动，下一帧校验元素相对视口顶的实际偏差与 scrollHeight 稳定
   * 性，两者同时满足才算落定；已稳定但偏差仍在且贴着可达底 → 目标本就
   * 在文档末尾附近（下方内容不足以把它顶到期望位置），按浏览器 clamp
   * 语义收底。
   *
   * 用户意图保护：wheel/touchstart/pointerdown 任一发生即作废本次纠偏
   * （程序性 scrollTop 写入——组件测量补偿、VirtualList 内部调整——不
   * 经这些事件，不受影响）。目标节点被卸载（数据更换/重挂载）同样放弃。
   */
  function jumpToElement(el: globalThis.Element, tries = JUMP_MAX_TRIES): void {
    const container0 = scrollEl();
    if (!container0) return;
    const seq = ++jumpSeq;

    /* 清理：移除用户意图监听。所有退出路径（收敛/取消/耗尽/换目标）统一走此 */
    const cleanup = (): void => {
      container0.removeEventListener("wheel", cancel);
      container0.removeEventListener("touchstart", cancel);
      container0.removeEventListener("pointerdown", cancel);
    };
    /** 用户开始手动滚动 → 作废本次纠偏（下一帧 seq 不匹配静默断链） */
    const cancel = (): void => {
      jumpSeq++;
      cleanup();
    };
    container0.addEventListener("wheel", cancel, { passive: true });
    container0.addEventListener("touchstart", cancel, { passive: true });
    container0.addEventListener("pointerdown", cancel, { passive: true }); // 滚动条拖拽

    /**
     * 单帧纠偏：重算目标 → 滚动（clamp 到可达底）→ 排下一帧校验。
     * @param remaining 剩余重试帧数
     * @param stable    scrollHeight 连续未变的帧数（两帧才算布局稳定：
     *                  RO 投递在帧内 rAF 之后、applyMeasurements 还要再排
     *                  一帧，单帧判定会间歇性提前放弃）
     * @param lastTotal 上一帧的 scrollHeight
     * @param wasClamped 上一帧目标是否超出可达范围（贴底收尾依据）
     */
    const attempt = (
      remaining: number,
      stable: number,
      lastTotal: number,
      wasClamped: boolean,
    ): void => {
      const container = scrollEl();
      // 目标卸载（数据更换/段重挂载）或已被新跳转/用户滚动接管：放弃
      if (!container || !el.isConnected || seq !== jumpSeq) {
        cleanup();
        return;
      }

      const cr = container.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      // 期望：元素顶落在视口顶下方 jumpOffset（查找面板让位）处
      const desired = container.scrollTop + (er.top - cr.top) - jumpOffset();
      const total = container.scrollHeight;
      const max = total - container.clientHeight;
      const clamped = desired > max + 1;
      vlist?.scrollTo(Math.min(desired, max));

      if (remaining <= 0) {
        cleanup();
        return;
      }
      requestAnimationFrame(() => {
        if (seq !== jumpSeq) return; // 已被取消/新跳转接管，链自然断
        const c2 = scrollEl();
        if (!c2 || !el.isConnected) {
          cleanup();
          return;
        }
        const cr2 = c2.getBoundingClientRect();
        const er2 = el.getBoundingClientRect();
        const dev = Math.abs(er2.top - cr2.top - jumpOffset());
        const st = c2.scrollHeight === total ? stable + 1 : 0;
        // 落定：布局连续两帧稳定，且偏差收敛（<1px）或目标贴可达底
        if (st >= 2 && (dev < 1 || clamped)) {
          cleanup();
          return;
        }
        attempt(remaining - 1, st, total, clamped);
      });
    };

    attempt(tries, 0, container0.scrollHeight, false);
  }

  /* ---------- 脚注跳转（自定义锚 #fn:N / #fnref:N:K） ---------- */

  /** 双 rAF：Svelte flush + 项布局落地后再做元素级修正（与 scrollToAnchor
   *  的挂载等待语义一致） */
  function afterLayout(fn: () => void): void {
    requestAnimationFrame(() => requestAnimationFrame(fn));
  }

  /**
   * 正文脚注引用 → 脚注列表项（#fn:N）：
   * 已挂载（列表在视口/overscan 内）直跳元素级定位；否则滚动到哨兵项
   * （列表末尾）触发挂载，落地后元素级修正（目标项可能在长列表深处）。
   */
  function jumpToFootnoteDef(n: number): void {
    if (n < 1) return;
    const mounted = scrollEl()?.querySelector(`[data-fn-index="${n}"]`);
    if (mounted) {
      jumpToElement(mounted);
      return;
    }
    if (items.length === 0 || items[items.length - 1] !== FOOTNOTES_SENTINEL)
      return;
    vlist?.scrollToIndex(items.length - 1, { align: "end" });
    afterLayout(() => {
      const el = scrollEl()?.querySelector(`[data-fn-index="${n}"]`);
      if (el) jumpToElement(el);
    });
  }

  /** 段内 md-footnote-ref 标记（指定 identifier）计数（深度优先文档序） */
  function countFnRefNodes(nodes: HastContent[], identifier: string): number {
    let count = 0;
    const walk = (n: HastContent): void => {
      if (n.type !== "element") return;
      const el = n as HastElement;
      if (
        el.tagName === "md-footnote-ref" &&
        readRefProp(el, "data-identifier") === identifier
      ) {
        count++;
      }
      el.children.forEach(walk);
    };
    nodes.forEach(walk);
    return count;
  }

  /** scrollToMatch 的跳转代数：新跳转让旧的 afterLayout 回调失效 */
  let matchJumpSeq = 0;

  /** 目标是否已在预览视口可视区（不被查找面板遮挡）内完整可见 */
  function isVisibleInViewport(
    el: HTMLElement,
    container: HTMLElement,
  ): boolean {
    const cr = container.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    const top = cr.top + jumpOffset();
    return er.top >= top && er.bottom <= cr.bottom;
  }

  /**
   * 查找匹配精确跳转（正文段 / 脚注区统一入口）。
   *
   * 依赖装饰器写入的 mark[data-mid="${id}"]：id 即 info.ranges 下标，
   * 全文档唯一。data-mid 不随 current 变化——只要目标虚拟项已挂载，
   * 目标 mark 就在 DOM 中，因此「是否挂载」不需要靠 scrollToIndex 试探。
   *
   * 分级策略（避免「先跳块再跳元素」的双重滚动）：
   * ① mark 已渲染且完整可见  → 不动（视口内切换匹配不滚动）；
   * ② mark 已渲染但视口外    → 直接元素级定位（jumpToElement），绝不跳块；
   * ③ mark 未渲染（虚拟项未挂载）→ scrollToIndex 挂载后元素级定位；
   * ④ 装饰仍未生效 / 自渲染分支 → 段级 / 脚注项级回退定位。
   */
  function scrollToMatch(id: number): void {
    const info = get(previewSearchState$).info;
    if (!info || id < 0 || id >= info.total) return;
    const segIndex = info.segOf[id];
    if (segIndex == null) return;

    const seq = ++matchJumpSeq;
    const isFootnote = segIndex >= segments.length;
    const container0 = scrollEl();
    if (!container0) return;

    const findMark = (c: HTMLElement): HTMLElement | null =>
      c.querySelector<HTMLElement>(`mark.pv-search-hl[data-mid="${id}"]`);

    // ①② 目标 mark 已渲染：按可见性决定是否滚动，不先跳块
    const mark0 = findMark(container0);
    if (mark0) {
      if (isVisibleInViewport(mark0, container0)) return; // 视口内：不动
      jumpToElement(mark0);
      return;
    }

    // ③ 目标 mark 未渲染 = 目标虚拟项未挂载 → 触发挂载
    if (isFootnote) {
      if (items.length > segments.length) {
        // 脚注列表非虚拟化：挂载哨兵项即挂载整列 <ol>
        vlist?.scrollToIndex(items.length - 1, { align: "end" });
      }
    } else {
      vlist?.scrollToIndex(segIndex, {
        align: "start",
        offset: jumpOffset(),
      });
    }

    // 挂载 + 装饰落地后（双 rAF：Svelte flush + 布局）元素级定位
    afterLayout(() => {
      if (seq !== matchJumpSeq) return; // 已被新跳转接管
      const container = scrollEl();
      if (!container) return;

      const markEl = findMark(container);
      if (markEl) {
        if (!isVisibleInViewport(markEl, container)) jumpToElement(markEl);
        return;
      }

      // ④ 回退：装饰仍未生效（极短窗口）或匹配落在自渲染分支
      if (isFootnote) {
        const li = findFootnoteElementByMatch(id, info);
        if (li) jumpToElement(li);
      } else {
        const seg = container.querySelector<HTMLElement>(
          `.md-item[data-index="${segIndex}"]`,
        );
        if (seg) jumpToElement(seg);
      }
    });
  }

  /**
   * 从匹配全局偏移反查所属脚注项（回退路径用）。
   * 偏移口径与 computePreviewMatches 一致：按 footnoteList$ 顺序累加。
   */
  function findFootnoteElementByMatch(
    id: number,
    info: PreviewMatchInfo,
  ): HTMLElement | null {
    const range = info.ranges[id];
    if (!range) return null;
    let offset = 0;
    for (const f of get(footnoteList$)) {
      const len = flattenHastText(f.def.children).length;
      if (range[0] < offset + len) {
        return (
          scrollEl()?.querySelector<HTMLElement>(
            `[data-fn-id="${CSS.escape(f.identifier)}"]`,
          ) ?? null
        );
      }
      offset += len;
    }
    return null;
  }

  /**
   * 脚注列表回链 → 正文第 K 次引用出现（#fnref:N:K）：
   * 虚拟化下挂载 DOM 的出现序计数不可靠（未挂载段打断计数）→ 以段 HAST
   * 数据为唯一事实源：按文档序扫描段列表定位第 K 次出现所在段 segIndex
   * 与段内序 jInSeg，scrollToIndex 挂载后在段容器（.md-item[data-index]）
   * 内取第 jInSeq 个 [data-fn-ref] 元素级定位。目标不存在（增量窗口 /
   * 无效锚）保守不动——与浏览器「无效锚点无副作用」行为一致。
   */
  function jumpToFootnoteRef(n: number, k: number): void {
    const info = $refsSnapshot$.footnoteRefs[n - 1];
    if (!info || k < 1) return;
    const { identifier } = info;

    // ① 正文段扫描（原逻辑）：命中直接元素级跳转
    let seen = 0;
    for (let s = 0; s < segments.length; s++) {
      const c = countFnRefNodes(segments[s].nodes, identifier);
      if (seen + c >= k) {
        const segIndex = s;
        const jInSeg = k - seen - 1;
        vlist?.scrollToIndex(segIndex, {
          align: "start",
          offset: jumpOffset(),
        });
        afterLayout(() => {
          const seg = scrollEl()?.querySelector(
            `.md-item[data-index="${segIndex}"]`,
          );
          const refs = seg?.querySelectorAll(
            `[data-fn-ref="${CSS.escape(identifier)}"]`,
          );
          const el = refs?.[jInSeg];
          if (el) jumpToElement(el);
        });
        return;
      }
      seen += c;
    }

    // ② 正文未命中 → 第 K 次出现在某脚注定义内（嵌套引用）。
    //    FootnoteDefEntry.children 已是 HAST（md-footnote-ref 标记由
    //    processFootnoteContent 保留），footnotes 数组按 defsByBlock 文档序，
    //    逐项累加即可对齐 walkRefs 统计 count 时的顺序。
    //    文档序假设：GFM 主流写法（定义在文末），"正文全部引用 → 定义内
    //    全部引用"即文档序——命中即精确；定义前置于正文的罕见写法下
    //    K 可能偏差，但用户几乎不可这样写（引用发生在定义书写位置之前）。
    let remaining = k - seen;
    for (const def of $refsSnapshot$.footnotes) {
      const c = countFnRefNodes(def.children, identifier);
      if (remaining <= c) {
        const ownerNumber = $footnoteNumberById$.get(def.identifier);
        if (ownerNumber != null) jumpToFootnoteDef(ownerNumber);
        return;
      }
      remaining -= c;
    }
    // 数据不一致（增量窗口 / 无效锚）：保守不动
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
        vlist?.scrollToIndex(segIndex, {
          align: "start",
          offset: jumpOffset(),
        });
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
    data={items}
    overscan={10}
    onscroll={handleScroll}
    role="log"
    aria-label="preview"
  >
    {#snippet children(seg, index)}
      {#if seg === FOOTNOTES_SENTINEL}
        <!-- 脚注列表项（文档末尾，只从全局 STORE 订阅）：包装与 MarkdownSegment
             同构（.md-item > .md-block），保证 .md-block 域下的既有内容样式适用 -->
        <div
          class="md-item md-item-footnotes"
          data-btype="footnotes"
          data-index={index}
        >
          <article class="md-block">
            <MarkdownFootnotes />
          </article>
        </div>
      {:else}
        <MarkdownSegment {seg} {index} />
      {/if}
    {/snippet}
  </VirtualList>
</div>
