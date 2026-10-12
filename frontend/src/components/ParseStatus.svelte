<script lang="ts">
  /**
   * 底栏解析状态指示器（原生 Svelte 组件）。
   *
   * - 数据源：parsePhase$（parsing / idle）+ parseContext$（open / blank-open / edit），
   *   自行测量每次解析耗时（毫秒，performance.now 差值）并维护统计；
   * - 三态：「准备就绪」/「解析中 + 加载动画 SVG」/「解析 {上次耗时}ms」；
   * - 展示规则：
   *   · edit 触发：解析持续超过 200ms 才出现「解析中」（等价于解析耗时 > 200ms）；
   *   · open 触发（打开文档）：无启动阈值，转圈立即出现；
   *   · 任何触发下「解析中」出现后至少停留 500ms 再切到耗时态；
   *   · 打开的是空白文档（blank-open）则直接使用「准备就绪」；
   * - 固定宽度：以三个状态中最宽者测量一次（含 4 位数耗时代表值），
   *   状态切换时宽度不抖动（tabular-nums 保证数字等宽）；
   * - tooltip：最大耗时 / 平均耗时（内部按 EWMA 平滑计算）/ 最小耗时；
   *   尚无数据时显示提示文案；全部文案走 svelte-i18n。
   */
  import { get } from "svelte/store";
  import { t } from "../lib/i18n.svelte";
  import { parsePhase$ as parsePhase, parseContext$ } from "../lib/stores";

  /** edit 触发下「解析中」出现阈值：解析持续超过该值才显示转圈 */
  const PARSING_DELAY_MS = 200;
  /** 「解析中」出现后至少停留时长（无论触发方式） */
  const MIN_VISIBLE_MS = 500;
  /** EWMA 平滑系数：越小越平滑（历史权重越大） */
  const EWMA_ALPHA = 0.25;
  /** 固定宽度测量用的耗时代表值（4 位数，tabular-nums 下覆盖常规区间） */
  const WIDTH_SAMPLE_MS = 8888;

  type View = "ready" | "parsing" | "done";

  /** 当前展示态与上次解析耗时（ms，四舍五入） */
  let view = $state<View>("ready");
  let duration = $state<number | null>(null);

  /** 耗时统计（tooltip 数据源）：最大 / 最小 / EWMA 平均 */
  let stats = $state({ hasData: false, max: 0, min: 0, ewma: 0 });

  /* ---- 非响应式的时序状态（定时器/代际计数防陈旧回调） ---- */
  let gen = 0; // 代际计数：每次 phase 变化自增，旧定时器回调据此失效
  let inFlight = false; // 当前是否有解析在途（过滤启动期多余的 idle 事件）
  let currentPhaseParsing = false; // 定时器回调里判断最新 phase（不读响应式状态）
  let lastCtx: "open" | "blank-open" | "edit" = "edit"; // 本次解析的触发上下文
  let startTs = 0; // 本次解析开始时刻
  let spinnerShownTs = 0; // 转圈出现时刻（≥500ms 停留的起算点）
  let spinnerVisible = false;
  let delayTimer: ReturnType<typeof setTimeout> | undefined; // 200ms 显示延迟
  let holdTimer: ReturnType<typeof setTimeout> | undefined; // 500ms 停留兜底

  function clearTimers(): void {
    clearTimeout(delayTimer);
    clearTimeout(holdTimer);
    delayTimer = undefined;
    holdTimer = undefined;
  }

  function showSpinner(): void {
    spinnerVisible = true;
    spinnerShownTs = performance.now();
    view = "parsing";
  }

  /** 收口：切到「解析 {上次耗时}ms」态 */
  function finishParse(dur: number): void {
    spinnerVisible = false;
    view = "done";
    duration = Math.round(dur);
  }

  /** 记录一次耗时统计（EWMA 平滑平均） */
  function recordStats(dur: number): void {
    stats.max = stats.hasData ? Math.max(stats.max, dur) : dur;
    stats.min = stats.hasData ? Math.min(stats.min, dur) : dur;
    stats.ewma = stats.hasData ? EWMA_ALPHA * dur + (1 - EWMA_ALPHA) * stats.ewma : dur;
    stats.hasData = true;
  }

  $effect(() => {
    const unsub = parsePhase.subscribe((phase) => {
      const myGen = ++gen;
      if (phase === "parsing") {
        // 新解析开始：作废旧定时器；转圈若已在显示则连续显示并重置停留起点
        inFlight = true;
        currentPhaseParsing = true;
        startTs = performance.now();
        lastCtx = get(parseContext$);
        clearTimers();
        if (lastCtx === "blank-open") {
          // 空白文档打开：不出「解析中」，直接使用「准备就绪」
          spinnerVisible = false;
          view = "ready";
          return;
        }
        if (lastCtx === "open") {
          // 打开操作：无启动阈值，立即转圈
          showSpinner();
        } else if (!spinnerVisible) {
          // 编辑触发：持续超过 200ms 才出现（等价于解析耗时 > 200ms）；
          // 出现前保持当前展示（上次的耗时态 / 准备就绪），不闪回
          delayTimer = setTimeout(() => {
            if (myGen === gen && currentPhaseParsing) showSpinner();
          }, PARSING_DELAY_MS);
        }
        return;
      }

      // idle：结果落地
      currentPhaseParsing = false;
      if (!inFlight) return; // 启动期初始值 / 重复 idle：忽略
      inFlight = false;
      clearTimers();
      if (lastCtx === "blank-open") {
        // 空白文档打开（合成相位事件，无真实解析）：不出转圈、不记统计，
        // 直接使用「准备就绪」
        spinnerVisible = false;
        view = "ready";
        return;
      }
      const dur = performance.now() - startTs;
      recordStats(dur);
      if (spinnerVisible) {
        // 「解析中」至少停留 500ms（从出现时刻起算）
        const remain = MIN_VISIBLE_MS - (performance.now() - spinnerShownTs);
        if (remain > 0) {
          holdTimer = setTimeout(() => {
            if (myGen === gen) finishParse(dur);
          }, remain);
          return;
        }
      }
      finishParse(dur);
    });
    return unsub;
  });

  /* ---- 派生展示 ---- */

  /** tooltip：无数据时提示文案；有数据时三行统计（换行在原生 tooltip 中生效） */
  const tooltip = $derived.by(() => {
    if (!stats.hasData) return $t("parse.tooltipEmpty");
    const ms = (v: number): number => Math.max(0, Math.round(v));
    return [
      $t("parse.max", { values: { ms: ms(stats.max) } }),
      $t("parse.avg", { values: { ms: ms(stats.ewma) } }),
      $t("parse.min", { values: { ms: ms(stats.min) } }),
    ].join("\n");
  });

  /* ---- 固定宽度：隐形 sizer 测量三个状态中最宽者（随语言/字号自适应，
   * 测量后作为固定宽度应用，状态切换不抖动）。
   * sizer 必须 w-max（width: max-content）：绝对定位元素默认受包含块
   * shrink-to-fit 约束，宽行（4 位数耗时）会在测量层内部先换行，
   * 导致测得的宽度不足。取整 + 1px 余量防亚像素取整换行。 ---- */
  let sizerW = $state(0);
  const boxW = $derived(sizerW > 0 ? Math.ceil(sizerW) + 1 : 96);
</script>

<!-- 固定宽度容器：三态内容居中，超宽截断（超出 4 位代表值时 tooltip 仍有完整数据） -->
<div
  class="relative flex-none select-none"
  role="status"
  title={tooltip}
>
  <div
    class="flex items-center justify-center gap-1.5 overflow-hidden whitespace-nowrap text-xs text-muted tabular-nums"
    style="width: {boxW}px;"
  >
    {#if view === "parsing"}
      <span>{$t("parse.parsing")}</span>
      <svg class="h-3.5 w-3.5 flex-none animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-opacity="0.25" stroke-width="3"></circle>
        <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="3" stroke-linecap="round"></path>
      </svg>
    {:else if view === "done"}
      <span>{$t("parse.done", { values: { ms: duration ?? 0 } })}</span>
    {:else}
      <span>{$t("parse.ready")}</span>
    {/if}
  </div>

  <!-- 隐形测量层：纵向堆叠三个状态行，宽度取最宽行。
       w-max 使其按 max-content 取宽，摆脱绝对定位包含块的
       shrink-to-fit 约束（否则 4 位数行在测量层内部就换行） -->
  <div
    aria-hidden="true"
    class="pointer-events-none invisible absolute left-0 top-0 -z-10 flex w-max flex-col whitespace-nowrap text-xs tabular-nums"
    bind:clientWidth={sizerW}
  >
    <span>{$t("parse.ready")}</span>
    <span class="flex items-center gap-1.5">
      <span>{$t("parse.parsing")}</span>
      <svg class="h-3.5 w-3.5 flex-none" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-opacity="0.25" stroke-width="3"></circle>
        <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="3" stroke-linecap="round"></path>
      </svg>
    </span>
    <span>{$t("parse.done", { values: { ms: WIDTH_SAMPLE_MS } })}</span>
  </div>
</div>
