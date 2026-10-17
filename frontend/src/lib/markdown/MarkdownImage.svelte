<script lang="ts" module>
  /**
   * 模块级图片状态缓存（跨组件实例共享）：
   * 组件实例被 Svelte 重建时（极端场景：整树替换、段索引移位），
   * 已加载过的 src 直接以上次终态首帧渲染——loaded 从 HTTP 缓存即时呈现，
   * error 细分（受限/不存在）不再重复 fetch 确认 → 「即使重建也不闪烁」的兜底。
   */
  type ImgStatus = "loading" | "loaded" | "error";
  /** error 细分："" 通用网络错误 / restricted 访问受限(401/403) / notfound 资源不存在(404) */
  type ImgErrorCode = "" | "restricted" | "notfound";
  interface CacheEntry {
    status: ImgStatus;
    code: ImgErrorCode;
  }
  const cache = new Map<string, CacheEntry>();
  const MAX_CACHE = 512;

  function record(src: string, entry: CacheEntry): void {
    cache.delete(src); // 重新插入实现 FIFO 刷新
    cache.set(src, entry);
    if (cache.size > MAX_CACHE) {
      const first = cache.keys().next().value;
      if (first !== undefined) cache.delete(first);
    }
  }

  /**
   * 构造「跳过缓存」的穿透参数（query 片段，追加在代理 URL 后）：
   * - cb=时间戳：绕过浏览器对同一 src 的内存/磁盘缓存，强制重新请求；
   * - remote 额外 refresh=1：后端 serveRemote 跳过磁盘缓存直连上游重下并覆盖缓存
   *   （remote 缓存键是原始 url 参数值，仅加 cb 仍会命中后端缓存）。
   * 非代理路径返回空串（无需穿透）。
   */
  function bustParams(src: string): string {
    if (!src.includes("/__imgproxy/")) return "";
    const remote = src.includes("/__imgproxy/remote");
    const sep = src.includes("?") ? "&" : "?";
    return `${sep}cb=${Date.now()}${remote ? "&refresh=1" : ""}`;
  }
</script>

<script lang="ts">
  /**
   * MarkdownImage：预览图片组件（块级 / 行内两种形态）。
   *
   * - 块级（inline=false，独立成段的图片，含 <a> 包裹独自成块）：
   *   占位三态统一 240px 高度；loaded 后 img 铺满、高度按图片比例自适应，
   *   alt 描述文本（caption）显示在图片底部；
   * - 不用 loading="lazy"：虚拟滚动下段只在视口附近挂载，lazy 的
   *   交叉观察反而推迟内存缓存命中与 load 事件 → 滚动往复时占位/空白
   *   帧闪烁；配合模块级终态缓存 + 命中时 sync 解码，重挂载首帧即有像素。
   * - 行内（inline=true，与文字混排等一切其他场景，data-inline 标注）：
   *   不设宽高，使用图片原本尺寸；占位为行内布局 [SVG 图标][说明文本][刷新]，
   *   高度以行高为准，描边与背景色与块级占位一致；描述文本以 title 属性呈现。
   * - 三态（loading / error / restricted / notfound）文案走 i18n（preview.*）；
   * - 刷新按钮：失败态占位为状态文本后的文字链接（loading 态不显示）；
   *   loaded 态为左上角图标按钮（悬停显示，无淡入淡出动画），点击重新请求
   *   并跳过前后端缓存；
   * - 依赖 docState.dir：目录变化时自动执行刷新（回占位态 + 缓存穿透重新请求）。
   */
  import { untrack } from "svelte";
  import { t } from "../i18n.svelte";
  import { docState$ } from "../stores";

  let {
    /** 代理 URL（编译期 rewriteImageSrc 生成的 /__imgproxy/... 路径） */
    src,
    alt = "",
    /** 行内形态（管线 data-inline 标注） */
    inline = false,
  }: {
    src: string;
    alt?: string;
    inline?: boolean;
  } = $props();

  // 空链接图片（data-src 为空或全空白，如 ![]()、<img src="">、<img>）：
  // 组件直接拦截——不生成代理 URL、img 不带 src 属性、不向后端图片代理发起
  // 任何请求（img 的 src 为空时浏览器会转而请求页面根地址，同样必须避免），
  // 首帧即通用失败终态；派生判定零成本，不写入模块缓存。
  const emptySrc = $derived(src.trim() === "");

  // 仅用于首帧快读（缓存命中则首帧即终态，
  // 避免闪烁）；props.src 的后续变化由下方 $effect 响应
  const cached = untrack(() => (emptySrc ? undefined : cache.get(src)));

  let status = $state<ImgStatus>(
    untrack(() => cached?.status ?? (emptySrc ? "error" : "loading")),
  );
  let errorCode = $state<ImgErrorCode>(cached?.code ?? "");
  /** 缓存命中 → 同步解码（见 img.decoding；重挂载首帧即有像素，不闪空白帧） */
  let decodeSync = $state(cached?.status === "loaded");
  /** 刷新穿透参数（query 片段）：doReload() 设置，src 变化时清零 */
  let bust = $state("");
  /**
   * 实际请求 URL：响应式派生自 props.src + 穿透参数。
   * 渲染器按索引复用组件实例（非 keyed each），编辑器修改图片地址时
   * props.src 更新 → imgSrc 即时跟随 → img 重新请求。
   * 空链接派生为 null：模板 src={null} 移除属性，img 不发起任何请求。
   */
  const imgSrc = $derived<string | null>(emptySrc ? null : src + bust);

  // props.src 变化（实例复用、非重建）→ 重置请求状态：空链接直接失败终态；
  // 模块缓存命中直接终态（不闪占位），否则回 loading；同时清掉针对旧地址
  // 的刷新穿透参数。
  $effect(() => {
    void src; // 建立追踪；bust/status/errorCode 仅写入、不参与依赖，无循环风险
    bust = "";
    if (emptySrc) {
      status = "error";
      errorCode = "";
      decodeSync = false;
      return;
    }
    const hit = cache.get(src);
    status = hit?.status ?? "loading";
    errorCode = hit?.code ?? "";
    decodeSync = hit?.status === "loaded";
  });

  /** 刷新：回占位态 + 缓存穿透参数重新请求。
   *  空链接直接返回：无请求可刷新，保持失败终态（不发任何请求） */
  function doReload(): void {
    if (emptySrc) return;
    classifySeq++;
    status = "loading";
    errorCode = "";
    bust = bustParams(src);
  }

  /**
   * 刷新按钮原生点击监听（角标 + 占位符刷新链接各一）。
   *
   * 不用 Svelte 的 onclick：Svelte 5 的 click 是应用根节点委托，事件先冒泡
   * 过预览面板滚动根（链接点击委托监听所在处）才到达委托点——带链接的图片
   * （块级图片可包在 <a> 内）点击刷新时会同时触发「打开链接 + 刷新」。
   * 这里直接在按钮元素上挂原生监听，冒泡途中即 stopPropagation +
   * preventDefault：点击刷新始终只触发刷新动作；点击占位符/图片的非刷新
   * 部分才会触发链接（链接行为由预览面板委托处理）。
   */
  let cornerBtn = $state<HTMLButtonElement | null>(null);
  let linkBtn = $state<HTMLButtonElement | null>(null);

  function nativeReloadHandler(ev: MouseEvent): void {
    ev.stopPropagation();
    ev.preventDefault();
    doReload();
  }

  $effect(() => {
    const btn = cornerBtn;
    if (!btn) return;
    btn.addEventListener("click", nativeReloadHandler);
    return () => btn.removeEventListener("click", nativeReloadHandler);
  });

  $effect(() => {
    const btn = linkBtn;
    if (!btn) return;
    btn.addEventListener("click", nativeReloadHandler);
    return () => btn.removeEventListener("click", nativeReloadHandler);
  });

  /**
   * 依赖 docState.dir：目录变化（切换不同目录下的文档）时对本图执行刷新
   * （回占位态 + 缓存穿透重新请求）。local 相对路径图片按请求时的目录解析，
   * dir 变化后必须重新请求才能命中新目录下的资源；remote 图片一并重下。
   * 首次运行仅记录基线 dir，不触发刷新。
   */
  const dir = $derived($docState$?.dir ?? "");

  let lastDir: string | null = null; // 普通变量，不是 $state
  $effect(() => {
    const d = dir; // 只读 dir，注册依赖
    if (lastDir === null) {
      lastDir = d;
      return;
    }
    if (lastDir === d) return;
    lastDir = d;
    if (emptySrc) return; // 空链接：保持失败终态，无请求可刷新
    classifySeq++; // 使进行中的过期复核失效（同 reload）
    status = "loading";
    errorCode = "";
    bust = bustParams(src);
  });

  /**
   * error 细分：对代理路径 HEAD 复核真实状态码（img error 事件不含状态信息）。
   * 复核期间组件保持 loading 态——不先落通用错误占位，复核完成后一次性
   * 切换到最终异常态（notfound / restricted / 通用失败），加载 → 异常
   * 永远只有一次切换、一个结果，不出现「失败 → 不存在」两段闪烁。
   * 代际守卫：复核 await 期间发生 reload / 换址（props.src 变化）时，
   * 过期结果直接丢弃（seq 失配或 src 已变），不回写状态与缓存。
   */
  let classifySeq = 0;

  async function classifyError(): Promise<void> {
    const seq = ++classifySeq;
    const target = src;
    let code: ImgErrorCode = "";
    if (target.includes("/__imgproxy/")) {
      try {
        const resp = await fetch(target, { method: "HEAD" });
        if (resp.status === 404) code = "notfound";
        else if (resp.status === 401 || resp.status === 403)
          code = "restricted";
      } catch {
        /* 网络错误保持通用失败态 */
      }
    }
    if (seq !== classifySeq || target !== src) return;
    errorCode = code;
    status = "error";
    record(target, { status: "error", code });
  }
</script>

<!-- data-inline 落 DOM：行内形态 CSS（md-image[data-inline]）的匹配依据 -->
<md-image
  data-status={status}
  data-error={errorCode || undefined}
  data-inline={inline ? "1" : undefined}
>
  <img
    class="md-img"
    src={imgSrc}
    {alt}
    title={inline && alt ? alt : undefined}
    decoding={decodeSync ? "sync" : "async"}
    onload={() => {
      status = "loaded";
      errorCode = "";
      record(src, { status: "loaded", code: "" });
    }}
    onerror={() => {
      // 不先落通用错误占位：保持 loading 态（HEAD 复核的是本地 imgproxy，
      // 耗时极短），复核完成后一次性切换到最终异常占位——加载 → 异常
      // 只有一次切换、一个结果；过期复核结果由 classifyError 内部守卫丢弃
      void classifyError();
    }}
  />
  {#if status === "loaded"}
    <!-- loaded 态：左上角刷新按钮（悬停显示，无淡入淡出动画） -->
    <button
      class="md-img-reload-corner"
      type="button"
      bind:this={cornerBtn}
      aria-label={$t("preview.imageReload")}
      title={$t("preview.imageReload")}
    >
      {#if inline}
        <!-- 行内刷新：1em，粗线圆弧 + 短箭头，缩小后仍可读 -->
        <svg
          viewBox="0 0 16 16"
          width="1em"
          height="1em"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
          <path d="M13.5 3.5v3.5H10" />
        </svg>
      {:else}
        <!-- 块级刷新：24px，开环 + 折角箭头 -->
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M21 12a9 9 0 1 1-2.64-6.36" />
          <path d="M21 3v6h-6" />
        </svg>
      {/if}
    </button>
    {#if !inline && alt}
      <!-- 块级图片的 alt 描述文本（caption，DOM 位于 img 之后 → 显示在底部）；
           行内不显示，描述文本走 title 悬停提示 -->
      <span class="md-img-cap">{alt}</span>
    {/if}
  {:else}
    <!-- 占位态：[SVG 图标][状态文本][刷新链接]（块级纵向居中、行内横排） -->
    <span class="md-img-ph">
      {#if inline}
        <!-- 行内占位符：16×16，width/height=1em，只保留核心符号并加粗，保证小尺寸可辨 -->
        {#if errorCode === "notfound"}
          <!-- 仅问号：目标图片不存在 -->
          <svg
            class="md-img-ic"
            viewBox="0 0 16 16"
            width="1em"
            height="1em"
            fill="none"
            stroke="currentColor"
            stroke-width="1.9"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M5.7 6.2a2.7 2.7 0 1 1 3.9 2.4c-.7.35-1 .85-1 1.6" />
            <circle cx="8.6" cy="13" r="1" fill="currentColor" stroke="none" />
          </svg>
        {:else if errorCode === "restricted"}
          <!-- 锁：访问受限（简化锁梁 + 锁体） -->
          <svg
            class="md-img-ic"
            viewBox="0 0 16 16"
            width="1em"
            height="1em"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <rect x="2.5" y="6" width="11" height="6.5" rx="1.5" />
            <path d="M5 6V4a3 3 0 0 1 6 0v2" />
          </svg>
        {:else if status === "loading"}
          <!-- 加载环：开口圆环，由 CSS 负责旋转 -->
          <svg
            class="md-img-ic"
            viewBox="0 0 16 16"
            width="1em"
            height="1em"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <circle cx="8" cy="8" r="5.5" stroke-dasharray="24 10.6" />
          </svg>
        {:else}
          <!-- 仅叉号：通用加载失败 -->
          <svg
            class="md-img-ic"
            viewBox="0 0 16 16"
            width="1em"
            height="1em"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <path d="M4.5 4.5l7 7" />
            <path d="M11.5 4.5l-7 7" />
          </svg>
        {/if}
      {:else}
        <!-- 块级占位符：24×24，精细线稿，语义清晰 -->
        {#if errorCode === "notfound"}
          <!-- 圆形 + 问号：有权访问但目标图片不存在 -->
          <svg
            class="md-img-ic"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M9.7 9.5a2.3 2.3 0 1 1 3.3 2.1c-.7.35-1 .85-1 1.7" />
            <circle cx="12" cy="16.2" r="0.8" fill="currentColor" stroke="none" />
          </svg>
        {:else if errorCode === "restricted"}
          <!-- 锁：代理白名单拒绝（403）或上游防盗链/禁止外链（401/403） -->
          <svg
            class="md-img-ic"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <rect x="4" y="9" width="16" height="9.5" rx="2" />
            <path d="M8 9V5.5a4 4 0 0 1 8 0V9" />
            <circle cx="12" cy="13.5" r="1.4" />
            <path d="M12 14.9v1.2" />
          </svg>
        {:else if status === "loading"}
          <!-- 加载环：开口圆环，由 CSS 负责旋转 -->
          <svg
            class="md-img-ic"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="8.5" stroke-dasharray="40 13.4" />
          </svg>
        {:else}
          <!-- 八边形 + 感叹号：通用加载失败（不可用） -->
          <svg
            class="md-img-ic"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M20.32 15.44 15.44 20.32H8.56L3.68 15.44V8.56L8.56 3.68H15.44L20.32 8.56Z" />
            <path d="M12 7.5v6" />
            <circle cx="12" cy="16.5" r="0.8" fill="currentColor" stroke="none" />
          </svg>
        {/if}
      {/if}
      <span class="md-img-ph-t">
        {#if status === "loading"}
          {$t("preview.imageLoading")}
        {:else if errorCode === "notfound"}
          {$t("preview.imageNotFound")}
        {:else if errorCode === "restricted"}
          {$t("preview.imageRestricted")}
        {:else}
          {$t("preview.imageFailed")}
        {/if}
        <!-- 刷新链接仅失败态显示：加载中不可刷新。
             原生监听（见脚本注释）：点击刷新只触发刷新，不触发外层链接 -->
        {#if status !== "loading"}
          <button class="md-img-reload-link" type="button" bind:this={linkBtn}>
            {$t("preview.imageReload")}
          </button>
        {/if}
      </span>
    </span>
  {/if}
</md-image>
