<script lang="ts" module>
  /**
   * 模块级 MathJax SVG 渲染管线 + LRU 缓存（跨组件实例共享）。
   *
   * - 选型：LaTeX → SVG 用 MathJax v3（tex-svg）；KaTeX 无 SVG 能力；
   * - mathjax-full + LiteAdaptor + 动态 import：首次遇到公式才加载 chunk；
   * - fontCache: "none" → 每个 SVG 自带 glyph 定义，无跨实例 <defs> 引用；
   * - 颜色：SVG 的 glyph fill/stroke 恒为 currentColor → 继承正文 --pv-fg，
   *   随主题切换，无需按主题重渲染；
   * - TeX 错误必须抛出：默认 formatError 会把语法错误编译成 merror 节点
   *   → SVG 渲染成黑色长条且 convert 不抛异常，组件无从感知；
   * - 缓存键 = contentHash(displayMode + "\0" + tex)；
   * - 编辑防抖：文本变化 250ms 后才请求；首次挂载直发。
   *
   * 【无渲染竞态说明】doc.convert 是纯同步（LiteAdaptor 无真实 DOM、单
   * 线程下不可能真并发），convert 期间不修改 TeX/SVG 配置（AllPackages、
   * fontCache 在初始化时固定）。因此不需要 Mermaid 那样的串行队列。
   *
   * 【renderer 失败重置】动态 import 失败时 renderer 变成永久 rejected
   * promise，后续所有渲染都会撞同一失败。失败后置 null 允许重试。
   */
  import { contentHash } from "../worker/contentHash";

  const MATH_CACHE_MAX = 128;
  interface MathEntry {
    /** SVG 字符串；null = 渲染失败（error 有效） */
    svg: string | null;
    /** 渲染错误信息（TeX 语法错误等） */
    error: string | null;
  }
  const mathCache = new Map<string, MathEntry>();

  /** 读取并刷新 LRU（有副作用；仅供 effect 等允许副作用的场景） */
  function mathCacheGet(key: string): MathEntry | undefined {
    const v = mathCache.get(key);
    if (v !== undefined) {
      mathCache.delete(key); // 重新插入实现 LRU 刷新
      mathCache.set(key, v);
    }
    return v;
  }

  /** 纯查询，不刷新 LRU（供 $derived 等纯计算场景使用） */
  function mathCachePeek(key: string): MathEntry | undefined {
    return mathCache.get(key);
  }

  function mathCacheSet(key: string, entry: MathEntry): void {
    mathCache.delete(key);
    mathCache.set(key, entry);
    if (mathCache.size > MATH_CACHE_MAX) {
      const oldest = mathCache.keys().next().value;
      if (oldest !== undefined) mathCache.delete(oldest);
    }
  }

  function mathCacheKey(display: boolean, tex: string): string {
    return contentHash((display ? "1" : "0") + "\0" + tex);
  }

  function extractErrorMessage(e: unknown): string {
    if (e == null) return "Unknown error";
    if (typeof e === "string") return e;
    if (e instanceof Error) {
      const anyE = e as { str?: unknown };
      if (typeof anyE.str === "string" && anyE.str.trim()) return anyE.str;
      return e.message || e.toString();
    }
    if (typeof e === "object") {
      const anyE = e as { str?: unknown; message?: unknown };
      if (typeof anyE.str === "string" && anyE.str.trim()) return anyE.str;
      if (typeof anyE.message === "string" && anyE.message.trim()) {
        return anyE.message;
      }
      try {
        const json = JSON.stringify(e);
        if (json && json !== "{}") return json;
      } catch {
        /* ignore */
      }
    }
    return String(e);
  }

  type RenderMath = (tex: string, display: boolean) => Promise<MathEntry>;
  let renderer: Promise<RenderMath> | null = null;

  /** 惰性加载 MathJax 并构建渲染函数（模块级单例） */
  async function getRenderer(): Promise<RenderMath> {
    if (!renderer) {
      renderer = (async () => {
        const [
          { mathjax },
          { TeX },
          { SVG },
          { AllPackages },
          { liteAdaptor },
          { RegisterHTMLHandler },
        ] = await Promise.all([
          import("mathjax-full/js/mathjax.js"),
          import("mathjax-full/js/input/tex.js"),
          import("mathjax-full/js/output/svg.js"),
          import("mathjax-full/js/input/tex/AllPackages.js"),
          import("mathjax-full/js/adaptors/liteAdaptor.js"),
          import("mathjax-full/js/handlers/html.js"),
        ]);
        const adaptor = liteAdaptor();
        RegisterHTMLHandler(adaptor);
        // formatError 抛出：TeX 语法错误 → convert 抛异常 → 组件错误占位态
        const texJax = new TeX({
          packages: AllPackages,
          formatError: (_jax: unknown, err: Error) => {
            throw err;
          },
        });
        const svgJax = new SVG({ fontCache: "none" });
        const doc = mathjax.document("", {
          InputJax: texJax,
          OutputJax: svgJax,
        });
        return async (tex: string, display: boolean): Promise<MathEntry> => {
          try {
            const node = doc.convert(tex, {
              display,
              em: 16,
              ex: 8,
              containerWidth: 1280,
            });
            // LiteAdaptor 产物为 <mjx-container><svg .../></mjx-container>，
            // 截取 svg 根（viewBox + ex 单位 width/height 齐备）
            const html = adaptor.outerHTML(node);
            const i = html.indexOf("<svg");
            const j = html.lastIndexOf("</svg>");
            if (i === -1 || j === -1) throw new Error("no svg output");
            return { svg: html.slice(i, j + 6), error: null };
          } catch (e) {
            return { svg: null, error: extractErrorMessage(e) };
          }
        };
      })();
      // 初始化失败时重置，允许后续挂载重试；原 rejection 仍抛给调用方
      renderer.catch(() => {
        renderer = null;
      });
    }
    return renderer;
  }
</script>

<script lang="ts">
  /**
   * 数学公式组件（MarkdownNode 对 md-math 的分派产物）。
   *
   * 【seq 语义】与 MermaidBlock 相同：每次 effect run 都无条件 ++seq，
   * 保证上一次 effect run 启动的 async 通过 mySeq !== seq 可靠过期；
   * 命中缓存时不启动新 async 也必须让旧 async 失效，否则 lastShown 会
   * 被旧 code 的渲染结果污染。
   *
   * 【firstRun】实例级首帧标志：首次 effect run 直发（0ms），此后走
   * 250ms 防抖。用实例标志而非 seq 判断，避免虚拟滚动重挂载时首次也
   * 走防抖。
   */
  import type { Element } from "hast";
  import { t } from "../i18n.svelte";
  import { readDataAttr } from "./hast-attrs";

  let { node }: { node: Element } = $props();

  /** TeX 源码（handler 保证唯一 text 子节点；兜底递归展平） */
  const tex = $derived.by(() => {
    let out = "";
    const walk = (ns: Element["children"]): void => {
      for (const n of ns) {
        if (n.type === "text") out += n.value;
        else if ("children" in n) walk((n as Element).children);
      }
    };
    walk(node.children);
    return out;
  });

  /** 独立块（$$...$$）＝ data-display="1"；行内（$...$）＝ "0"。
   *  属性键双形态兼容：rehype-raw 融合路径会把 kebab（data-display）
   *  规范化为 camelCase（dataDisplay），读取必须两种键名都兼容，
   *  否则文档含任意 raw HTML 时独立块会被降级成行内渲染。 */
  const display = $derived(
    readDataAttr(
      node.properties as Record<string, unknown> | undefined,
      "data-display",
    ) === "1",
  );

  let cacheVersion = $state(0);

  /* $derived 内必须用纯查询（peek）：get 会刷新 LRU，属于副作用。 */
  const cached = $derived.by(() => {
    void cacheVersion; // 订阅：缓存写入后触发重算
    if (!tex.trim()) return null;
    return mathCachePeek(mathCacheKey(display, tex)) ?? null;
  });

  let lastShown = $state<MathEntry | null>(null);

  let seq = 0;
  let firstRun = true;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  /* effect cleanup 后置 true：跳过对已销毁实例的状态写入 */
  let disposed = false;

  type MathPhase = "ready" | "error" | "updating" | "parsing";
  const phase = $derived<MathPhase>(
    cached
      ? cached.svg
        ? "ready"
        : "error"
      : lastShown
        ? "updating"
        : "parsing",
  );

  const errorTitle = $derived(
    phase === "error" && cached?.error
      ? $t("preview.mathRenderFailed") + cached.error
      : undefined,
  );

  $effect(() => {
    disposed = false;
    /* 无条件递增：保证上一次 effect run 启动的 async 可靠过期 */
    const mySeq = ++seq;
    const immediate = firstRun;
    firstRun = false;

    const src = tex;
    const disp = display;
    if (!src.trim()) {
      /* 空源码：清空 lastShown，避免旧 SVG 残留 */
      lastShown = null;
      return;
    }

    const hit = mathCacheGet(mathCacheKey(disp, src));
    if (hit) {
      lastShown = hit;
      return;
    }

    debounceTimer = setTimeout(
      () => {
        void (async () => {
          // 防抖等待期其他实例可能已完成同一 key 的渲染并写入缓存，复用
          const again = mathCacheGet(mathCacheKey(disp, src));
          if (again) {
            if (mySeq !== seq) return;
            lastShown = again;
            if (!disposed) cacheVersion++;
            return;
          }
          let r: MathEntry;
          try {
            const render = await getRenderer();
            r = await render(src, disp);
          } catch (e) {
            // getRenderer 初始化失败兜底：否则 unhandled rejection 且
            // 组件永久停留 parsing
            r = { svg: null, error: extractErrorMessage(e) };
          }
          if (mySeq !== seq) return;
          mathCacheSet(mathCacheKey(disp, src), r);
          lastShown = r;
          if (!disposed) cacheVersion++;
        })();
      },
      immediate ? 0 : 250,
    );
    return () => {
      clearTimeout(debounceTimer);
      disposed = true;
    };
  });
</script>

{#if display}
  <span class="md-math md-math-display" title={errorTitle}>
    {#if phase === "ready"}
      {@html cached?.svg}
    {:else if phase === "error"}
      <!-- 错误终态：字面量淡化（无扫光），错误详情在 title -->
      <span class="md-math-lit">{tex}</span>
    {:else if phase === "updating"}
      <!-- 块更新：旧 SVG 继续显示、淡化；旧内容为错误占位时退回字面量 -->
      {#if lastShown?.svg}
        <span class="md-skel">{@html lastShown.svg}</span>
      {:else}
        <span class="md-skel"><span class="md-math-lit">{tex}</span></span>
      {/if}
    {:else}
      <!-- 解析中：TeX 字面量淡化 -->
      <span class="md-skel"><span class="md-math-lit">{tex}</span></span>
    {/if}
  </span>
{:else}
  <span class="md-math md-math-inline" title={errorTitle}>
    {#if phase === "ready"}
      {@html cached?.svg}
    {:else if phase === "error"}
      <span class="md-math-lit">{tex}</span>
    {:else if phase === "updating"}
      {#if lastShown?.svg}
        <span class="md-skel">{@html lastShown.svg}</span>
      {:else}
        <span class="md-skel"><span class="md-math-lit">{tex}</span></span>
      {/if}
    {:else}
      <span class="md-skel"><span class="md-math-lit">{tex}</span></span>
    {/if}
  </span>
{/if}

<style>
  .md-math {
    background: transparent;
    color: inherit; /* MathJax SVG glyph 为 currentColor → 随正文色 */
  }

  /* 行内：MathJax 原生 ex 单位 width/height（默认宽高，随字号缩放） */
  .md-math-inline {
    display: inline-block;
    line-height: 1;
  }

  /* 独立块：不再占满宽度，改用相对字号（1.5em）与行内（1em）区分。
     MathJax SVG 的 width/height 为 ex 单位 → 随 font-size 等比缩放，
     放大不变形；块级独占一行 + 居中。 */
  .md-math-display {
    display: block;
    font-size: 1.5em;
    text-align: center;
    margin: 0.6em 0;
  }

  .md-math-display :global(svg) {
    height: auto;
    max-width: 100%;
  }

  .md-math-display :global(svg),
  .md-math-inline :global(svg) {
    vertical-align: middle;
  }

  /* 字面量（解析中 / 块更新回退 / 错误终态）：淡化 + 保留源码排版 */
  .md-math-lit {
    color: var(--pv-muted);
    white-space: pre-wrap;
    word-break: break-all;
    line-height: inherit;
  }
  .md-math-display .md-math-lit {
    display: inline-block;
    text-align: left;
    max-width: 100%;
  }

  /* 占位淡化（与 MermaidBlock 同款）：仅降低不透明度，不引入扫光动画 */
  .md-skel {
    display: inline-block;
    opacity: 0.45;
  }

  /* display 块内的占位容器：块级居中，不再满宽（与就绪态一致）；
     字号继承 .md-math-display 的 1.5em，占位与就绪态视觉尺度一致，
     避免块更新时尺寸跳变。 */
  .md-math-display .md-skel {
    display: block;
    min-height: 1.5em;
    text-align: center;
  }
</style>
