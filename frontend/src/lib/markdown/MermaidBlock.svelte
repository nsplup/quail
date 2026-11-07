<script lang="ts" module>
  /**
   * 模块级 Mermaid 渲染管线 + LRU 缓存（跨组件实例共享）。
   *
   * - 动态 import：首次遇到 mermaid 围栏才加载 chunk（~1MB 级，主 bundle
   *   与启动耗时零影响）；
   * - 主题同步（产品要求）：不再逐变量手工映射 themeVariables，而是从当前
   *   配色方案推断一个气质相近的 mermaid 官方主题打底（见 themes.ts 的
   *   inferMermaidTheme：深色 → dark；强调色绿系 → forest；低饱和灰调 →
   *   neutral；其余 → default）。仅额外覆盖 background / fontFamily /
   *   fontSize：SVG 背景必须与 .mermaid-wrap 容器（--pv-code-bg）同色，
   *   否则官方主题自带背景色会在容器内形成色块断层；
   * - 缓存键 = contentHash(themeId + "\0" + code)：主题切换产生新键，
   *   同主题下源码不变跨重挂载（虚拟滚动往返）即时命中，防闪烁；
   *   键内掺 themeId 防止主题切换后串色；
   * - securityLevel: "strict"（mermaid 默认）净化输出，{@html} 注入安全；
   *   suppressErrorRendering 关闭 mermaid 自带错误 SVG（错误走组件占位态）；
   * - 编辑防抖：文本变化 250ms 后才渲染；首次挂载直发（同 CodeBlock）。
   */
  import { contentHash } from "../worker/contentHash";
  import { getTheme, inferMermaidTheme, type MermaidTheme } from "../themes";
  import type { ThemeId } from "../types";

  const MERMAID_CACHE_MAX = 32;
  interface MermaidEntry {
    /** SVG 字符串；null = 渲染失败（error 有效） */
    svg: string | null;
    /** 渲染错误信息（图表语法错误等） */
    error: string | null;
  }
  const mermaidCache = new Map<string, MermaidEntry>();

  function mermaidCacheGet(key: string): MermaidEntry | undefined {
    const v = mermaidCache.get(key);
    if (v !== undefined) {
      mermaidCache.delete(key); // 重新插入实现 LRU 刷新
      mermaidCache.set(key, v);
    }
    return v;
  }

  function mermaidCacheSet(key: string, entry: MermaidEntry): void {
    mermaidCache.delete(key);
    mermaidCache.set(key, entry);
    if (mermaidCache.size > MERMAID_CACHE_MAX) {
      const oldest = mermaidCache.keys().next().value;
      if (oldest !== undefined) mermaidCache.delete(oldest);
    }
  }

  function mermaidCacheKey(themeId: string, code: string): string {
    return contentHash(themeId + "\0" + code);
  }

  /**
   * 由主题条目构建 mermaid 初始化配置：官方主题打底（推断结果），
   * 仅覆写背景与字体，其余配色交给官方主题（允许不完全匹配）。
   */
  function buildMermaidConfig(themeId: ThemeId): {
    theme: MermaidTheme;
    themeVariables: Record<string, string>;
  } {
    const theme = getTheme(themeId);
    return {
      theme: inferMermaidTheme(theme),
      themeVariables: {
        background: theme.vars["--pv-code-bg"] ?? "transparent",
        fontFamily:
          theme.vars["--pv-font-family"] ??
          "ui-sans-serif, system-ui, sans-serif",
        fontSize: "14px",
      },
    };
  }

  type RenderMermaid = (
    code: string,
    themeId: ThemeId,
  ) => Promise<MermaidEntry>;
  let renderer: Promise<RenderMermaid> | null = null;

  /** 惰性加载 mermaid 并构建渲染函数（模块级单例；render id 全局自增防碰撞） */
  async function getRenderer(): Promise<RenderMermaid> {
    renderer ??= (async () => {
      const mermaid = (await import("mermaid")).default;
      let seq = 0;
      return async (code: string, themeId: ThemeId): Promise<MermaidEntry> => {
        try {
          const { theme, themeVariables } = buildMermaidConfig(themeId);
          // initialize 每次渲染前调用：主题切换后更新全局配置（官方推荐做法）
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: "strict",
            suppressErrorRendering: true,
            theme,
            themeVariables,
          });
          const { svg } = await mermaid.render(`mermaid-${++seq}`, code);
          return { svg, error: null };
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
   * Mermaid 图表组件（MarkdownNode 对 pre>code.language-mermaid 的分派
   * 产物；源码文本提取与 CodeBlock 同口径）。
   *
   * - 【块背景色】与代码块一致：恒有块背景（--pv-code-bg + --pv-border
   *   同款容器），区别于 MarkdownMath 的透明融合（产品要求）；
   * - 主题同步：$effect 依赖 theme$，主题切换 → 重新渲染本块（缓存键
   *   含 themeId，同源码不串色）；渲染期按推断出的官方主题渲染
   *   （见模块级 buildMermaidConfig / themes.ts inferMermaidTheme）；
   * - 查找：彻底排除匹配（不计数/不导航/不装饰），见 previewSearch.ts
   *   isSearchExcluded——本组件不渲染任何 mark，与该约定一致。
   * - 渲染失败（图表语法错误）：错误占位态 + 错误信息；源码复制按钮
   *   复用 CodeBlock 同款交互（悬停显示，visibility 显隐）。
   */
  import type { Element } from "hast";
  import Icon from "../../components/Icon.svelte";
  import { t } from "../i18n.svelte";
  import { theme$ as theme } from "../stores";

  let { node }: { node: Element } = $props();

  /** 源码文本（pre>code 的 text 子节点拼接；与 CodeBlock 同口径） */
  const code = $derived.by(() => {
    let out = "";
    const walk = (ns: Element["children"]): void => {
      for (const n of ns) {
        if (n.type === "text") out += n.value;
        else if ("children" in n) walk((n as Element).children);
      }
    };
    for (const c of node.children) {
      if (c.type === "element" && (c as Element).tagName === "code") {
        walk((c as Element).children);
      }
    }
    return out;
  });

  /* 挂载首帧同步命中缓存；未命中 debounce 250ms 渲染（防打字洪峰）。
     entry 是 $derived（只读）：只从缓存读，不直接赋值（$derived 不可写）；
     缓存写入后通过 cacheVersion 自增这一响应式信号触发 derived 重算回显。
     effect 不读 cacheVersion，故不会因版本变化而重跑，无死循环。 */
  let cacheVersion = $state(0);

  let entry = $derived.by(() => {
    void cacheVersion; // 订阅：缓存写入后触发重算
    if (!code.trim()) return null;
    return mermaidCacheGet(mermaidCacheKey($theme, code)) ?? null;
  });

  let seq = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  /* effect cleanup 后置 true：跳过对已销毁实例的状态写入。
     注意缓存本身仍会写入（跨实例共享，下次挂载可命中）。 */
  let disposed = false;

  $effect(() => {
    disposed = false; // effect 重跑（依赖变化）时复位
    const th = $theme; // 订阅主题：切换即重渲染（缓存键随 themeId 变化）
    const src = code;
    if (!src.trim()) return;
    if (mermaidCacheGet(mermaidCacheKey(th, src))) return; // 首帧已命中
    const mySeq = ++seq;
    debounceTimer = setTimeout(
      () => {
        void (async () => {
          const r = await (await getRenderer())(src, th);
          if (mySeq !== seq) return; // 过期响应丢弃
          // 缓存写入跨实例共享：即使本实例已销毁也值得写（下次挂载直接命中）
          mermaidCacheSet(mermaidCacheKey(th, src), r);
          if (!disposed) cacheVersion++; // 仅在存活实例上触发回显
        })();
      },
      mySeq === 1 ? 0 : 250,
    );
    return () => {
      clearTimeout(debounceTimer);
      disposed = true;
    };
  });

  /* ---------- 源码复制按钮（与 CodeBlock 同款交互） ---------- */
  let copied = $state(false);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;

  async function writeClipboard(text: string): Promise<boolean> {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      /* 回退 execCommand */
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;left:-9999px;top:0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }

  async function copyCode(): Promise<void> {
    const ok = await writeClipboard(code);
    if (!ok) return;
    copied = true;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copied = false), 1500);
  }
</script>

<div class="mermaid-wrap">
  {#if entry?.svg}
    <div class="mermaid-svg">{@html entry.svg}</div>
  {:else if entry?.error}
    <div class="mermaid-error">
      {$t("preview.mermaidRenderFailed")}{entry.error}
    </div>
  {/if}
  <button
    class="code-copy-btn"
    class:copied
    type="button"
    title={copied ? $t("preview.codeCopied") : $t("preview.copyCode")}
    aria-label={copied ? $t("preview.codeCopied") : $t("preview.copyCode")}
    onclick={copyCode}
  >
    <Icon name={copied ? "check" : "copy"} size={13} />
  </button>
</div>

<style>
  /* 【块背景色】与 .md-block pre（代码块）同款：恒有背景 + 边框（产品要求） */
  .mermaid-wrap {
    position: relative;
    margin: 0.8em 0;
    padding: 14px 16px;
    background: var(--pv-code-bg);
    border: 1px solid var(--pv-border);
    border-radius: 10px;
    overflow-x: auto;
  }

  .mermaid-svg {
    display: flex;
    justify-content: center;
  }

  /* {@html} 注入产物需 :global：SVG 满宽不超容器、自适应高度 */
  .mermaid-svg :global(svg) {
    max-width: 100%;
    height: auto;
  }

  .mermaid-error {
    color: var(--pv-muted);
    font-size: 0.85em;
    word-break: break-all;
  }

  /* 复制按钮：与 CodeBlock 同款显隐（visibility，不用 opacity） */
  .code-copy-btn {
    position: absolute;
    top: 8px;
    right: 8px;
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    padding: 0;
    border: 1px solid var(--pv-border);
    border-radius: 6px;
    background: var(--pv-code-bg);
    color: var(--pv-muted);
    cursor: pointer;
    visibility: hidden;
    pointer-events: none;
    transition:
      visibility 0.15s,
      color 0.15s,
      border-color 0.15s;
  }

  .mermaid-wrap:hover .code-copy-btn,
  .code-copy-btn:focus-visible,
  .code-copy-btn.copied {
    visibility: visible;
    pointer-events: auto;
  }

  .code-copy-btn:hover {
    color: var(--pv-fg);
    border-color: var(--pv-muted);
  }

  .code-copy-btn.copied {
    color: var(--ui-accent);
  }
</style>
