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
  /** 刷新穿透参数（query 片段）：reload() 设置，src 变化时清零 */
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

  /** 刷新：回占位态 + 缓存穿透参数重新请求（阻止冒泡——块级图片可能在 <a> 内）；
   *  classifySeq++ 使进行中的过期复核失效（结果落地不回跳刚设置的 loading）。
   *  空链接直接返回：无请求可刷新，保持失败终态（不发任何请求） */
  function reload(ev: MouseEvent): void {
    ev.stopPropagation();
    ev.preventDefault();
    if (emptySrc) return;
    classifySeq++;
    status = "loading";
    errorCode = "";
    bust = bustParams(src);
  }

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
      onclick={reload}
      aria-label={$t("preview.imageReload")}
      title={$t("preview.imageReload")}
    >
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
    </button>
    {#if !inline && alt}
      <!-- 块级图片的 alt 描述文本（caption，DOM 位于 img 之后 → 显示在底部）；
           行内不显示，描述文本走 title 悬停提示 -->
      <span class="md-img-cap">{alt}</span>
    {/if}
  {:else}
    <!-- 占位态：[SVG 图标][状态文本][刷新链接]（块级纵向居中、行内横排） -->
    <span class="md-img-ph">
      {#if errorCode === "notfound"}
        <!-- 图片框 + 问号：有权访问但目标图片不存在 -->
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
          <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
          <path d="M9.7 9.3a2.3 2.3 0 1 1 3.3 2.1c-.7.35-1 .85-1 1.7" />
          <circle cx="12" cy="16" r="0.55" fill="currentColor" stroke="none" />
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
          <rect x="4" y="10.5" width="16" height="9.5" rx="2" />
          <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
        </svg>
      {:else if status === "loading"}
        <!-- 加载环：旋转动画表达加载中（无透明度/呼吸动画） -->
        <svg
          class="md-img-ic"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="8.5" stroke-dasharray="40 13.4" />
        </svg>
      {:else}
        <!-- 图片图标：加载失败（网络/上游等通用错误） -->
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
          <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
          <circle cx="9" cy="10" r="1.6" />
          <path d="M4.5 17.5l4.4-4.4a1.5 1.5 0 0 1 2.1 0l5.5 5.4" />
          <path d="M14.5 15.5l1.9-1.9a1.5 1.5 0 0 1 2.1 0l2 2" />
        </svg>
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
        <!-- 刷新链接仅失败态显示：加载中不可刷新 -->
        {#if status !== "loading"}
          <button class="md-img-reload-link" type="button" onclick={reload}>
            {$t("preview.imageReload")}
          </button>
        {/if}
      </span>
    </span>
  {/if}
</md-image>
