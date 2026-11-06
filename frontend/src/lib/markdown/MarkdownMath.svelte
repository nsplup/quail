<script lang="ts" module>
  /**
   * 模块级 MathJax SVG 渲染管线 + LRU 缓存（跨组件实例共享）。
   *
   * - 选型（决策点 B）：LaTeX 渲染成 SVG 必须用 MathJax v3（tex-svg），
   *   KaTeX 仅支持 HTML+MathML 输出、无 SVG 能力；
   * - mathjax-full 模块化 API + LiteAdaptor（LiteDOM 无真实 DOM 依赖）+
   *   动态 import：首次遇到公式才加载 chunk，主 bundle 与启动耗时零影响
   *   （桌面应用无网络成本，仅省首帧内存）；
   * - fontCache: "none" → 每个 SVG 自带 glyph 定义，无跨实例 <defs> 引用，
   *   {@html} 插入 / 缓存复用均安全；
   * - 颜色：SVG 输出的 glyph fill/stroke 恒为 currentColor → 公式颜色
   *   自然继承正文 --pv-fg，随主题切换，无需按主题重渲染；
   * - 缓存键 = contentHash(displayMode + "\0" + tex)：虚拟滚动卸载/重挂载
   *   首帧同步命中，不闪加载占位（与 CodeBlock 的 hlCache 同模式）；
   * - 编辑防抖：文本变化 250ms 后才请求；首次挂载直发（同 CodeBlock）。
   *
   * 首帧布局：缓存未命中首帧为空白占位（SVG 不可预知高度，无法像
   * CodeBlock 那样用等高纯文本垫底），命中后零闪烁——这是可接受折衷。
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

  function mathCacheGet(key: string): MathEntry | undefined {
    const v = mathCache.get(key);
    if (v !== undefined) {
      mathCache.delete(key); // 重新插入实现 LRU 刷新
      mathCache.set(key, v);
    }
    return v;
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

  type RenderMath = (tex: string, display: boolean) => Promise<MathEntry>;
  let renderer: Promise<RenderMath> | null = null;

  /** 惰性加载 MathJax 并构建渲染函数（模块级单例） */
  async function getRenderer(): Promise<RenderMath> {
    renderer ??= (async () => {
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
      const texJax = new TeX({ packages: AllPackages });
      const svgJax = new SVG({ fontCache: "none" });
      const doc = mathjax.document("", { InputJax: texJax, OutputJax: svgJax });
      return async (tex: string, display: boolean): Promise<MathEntry> => {
        try {
          const node = doc.convert(tex, {
            display,
            em: 16,
            ex: 8,
            containerWidth: 1280,
          });
          // LiteAdaptor 产物为 <mjx-container><svg .../></mjx-container>，
          // 截取 svg 根（viewBox + ex 单位 width/height 齐备，行为同 img）
          const html = adaptor.outerHTML(node);
          const i = html.indexOf("<svg");
          const j = html.lastIndexOf("</svg>");
          if (i === -1 || j === -1) throw new Error("no svg output");
          return { svg: html.slice(i, j + 6), error: null };
        } catch (e) {
          return {
            svg: null,
            error: e instanceof Error ? e.message : String(e),
          };
        }
      };
    })();
    return renderer;
  }
</script>

<script lang="ts">
  /**
   * 数学公式组件（MarkdownNode 对 md-math 的分派产物）。
   *
   * - 形态（对齐 MarkdownImage 的行内/独立块约定，由 handler 的
   *   data-display 标记驱动，无需上下文推断）：
   *   · 独立块（$$...$$，data-display="1"）：容器满宽、水平居中，
   *     SVG width:100% + height:auto（viewBox 保比例，高度自适应）；
   *   · 行内（$...$）：不干预 MathJax 原生 ex 单位 width/height
   *     （默认宽高，随正文字号缩放）。
   * - 【无块背景色】独立块与行内均透明背景，与正文直接融合（产品要求，
   *   区别于代码块 / Mermaid 的块背景）。
   * - 查找：彻底排除匹配（不计数/不导航/不装饰），见 previewSearch.ts
   *   isSearchExcluded——本组件不渲染任何 mark，与该约定一致。
   */
  import type { Element } from "hast";
  import { t } from "../i18n.svelte";

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

  /** 独立块（$$...$$）＝ data-display="1"；行内（$...$）＝ "0" */
  const display = $derived(
    (node.properties as Record<string, unknown> | undefined)?.[
      "data-display"
    ] === "1",
  );

  /* 挂载首帧同步命中缓存；未命中 debounce 250ms 渲染（防打字洪峰）。
     只写 entry 不读 entry：不建立对 entry 的依赖，避免写入触发重跑死循环 */
  let entry = $derived.by(() => {
    if (!tex.trim()) return null;
    return mathCacheGet(mathCacheKey(display, tex)) ?? null;
  });

  let seq = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    const src = tex;
    const disp = display;
    if (!src.trim()) return;
    if (mathCacheGet(mathCacheKey(disp, src))) return; // 首帧已命中
    const mySeq = ++seq;
    debounceTimer = setTimeout(
      () => {
        void (async () => {
          const r = await (await getRenderer())(src, disp);
          if (mySeq !== seq) return; // 过期响应丢弃
          mathCacheSet(mathCacheKey(disp, src), r);
          entry = r;
        })();
      },
      mySeq === 1 ? 0 : 250,
    );
    return () => clearTimeout(debounceTimer);
  });
</script>

{#if display}
  <span class="md-math md-math-display">
    {#if entry?.svg}{@html entry.svg}{:else if entry?.error}<span class="md-math-error"
        >{$t("preview.mathRenderFailed")}{entry.error}</span
      >{/if}
  </span>
{:else}
  <span class="md-math md-math-inline">
    {#if entry?.svg}{@html entry.svg}{:else if entry?.error}<span class="md-math-error"
        >{$t("preview.mathRenderFailed")}{entry.error}</span
      >{/if}
  </span>
{/if}

<style>
  /* 【无块背景色】独立块与行内均透明，与正文融合（产品要求） */
  .md-math {
    background: transparent;
    color: inherit; /* MathJax SVG glyph 为 currentColor → 随正文色 */
  }

  /* 行内：MathJax 原生 ex 单位 width/height（默认宽高，随字号缩放） */
  .md-math-inline {
    display: inline-block;
    line-height: 1;
  }

  /* 独立块：满宽居中；SVG 满宽 + height:auto（viewBox 保比例自适应） */
  .md-math-display {
    display: block;
    width: 100%;
    text-align: center;
    margin: 0.6em 0;
  }

  .md-math-display :global(svg) {
    width: 100%;
    height: auto;
    max-width: 100%;
  }

  .md-math-display :global(svg),
  .md-math-inline :global(svg) {
    vertical-align: middle;
  }

  /* 渲染失败：muted 提示 + 错误信息（纯文本节点，无注入通道） */
  .md-math-error {
    color: var(--pv-muted);
    font-size: 0.85em;
    word-break: break-all;
  }
</style>
