<script lang="ts" module>
  /**
   * 模块级 Mermaid 渲染管线 + LRU 缓存（跨组件实例共享）。
   *
   * - 动态 import：首次遇到 mermaid 围栏才加载 chunk；
   * - 主题同步（解耦后）：从当前配色方案推断官方主题（inferMermaidTheme），
   *  initialize 只传 theme，不再覆写 themeVariables；重渲染仅由「推断出的
   *   mermaid 主题」驱动，全局 themeId 变化但映射不变时直接复用缓存；
   * - 缓存键 = contentHash(推断主题 + "\0" + code)；
   * - securityLevel: "strict"；suppressErrorRendering 关闭 mermaid 自带
   *   错误 SVG（错误走组件占位态）；
   * - 编辑防抖：文本变化 250ms 后才渲染；首次挂载直发。
   *
   * 【竞态防护】
   * - enqueue：mermaid.initialize 修改的是模块级全局配置，而 render 是
   *   异步的。两个并发渲染会互相覆盖主题（A 的 initialize 被 B 覆盖，
   *   A 的 render 读到 B 的配置）。用串行队列把 initialize + render
   *   包进同一互斥区；
   * - inflight：多实例同时挂载同一图表时复用同一 promise，避免重复
   *   重型渲染；key 与组件缓存键同口径；
   * - renderer 失败重置：动态 import 失败时 renderer 变成永久 rejected
   *   promise，后续所有渲染都会撞同一失败。失败后置 null 允许重试。
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

  /** 读取并刷新 LRU（有副作用；仅供 effect 等允许副作用的场景） */
  function mermaidCacheGet(key: string): MermaidEntry | undefined {
    const v = mermaidCache.get(key);
    if (v !== undefined) {
      mermaidCache.delete(key); // 重新插入实现 LRU 刷新
      mermaidCache.set(key, v);
    }
    return v;
  }

  /** 纯查询，不刷新 LRU（供 $derived 等纯计算场景使用） */
  function mermaidCachePeek(key: string): MermaidEntry | undefined {
    return mermaidCache.get(key);
  }

  function mermaidCacheSet(key: string, entry: MermaidEntry): void {
    mermaidCache.delete(key);
    mermaidCache.set(key, entry);
    if (mermaidCache.size > MERMAID_CACHE_MAX) {
      const oldest = mermaidCache.keys().next().value;
      if (oldest !== undefined) mermaidCache.delete(oldest);
    }
  }

  /** 缓存键：推断出的 mermaid 主题（非全局 themeId）+ 源码 */
  function mermaidCacheKey(mTheme: MermaidTheme, code: string): string {
    return contentHash(mTheme + "\0" + code);
  }

  /**
   * 由主题条目构建 mermaid 初始化配置：官方主题打底（推断结果）
   */
  function buildMermaidConfig(themeId: ThemeId): {
    theme: MermaidTheme;
  } {
    const theme = getTheme(themeId);
    return {
      theme: inferMermaidTheme(theme),
    };
  }

  type RenderMermaid = (
    code: string,
    themeId: ThemeId,
  ) => Promise<MermaidEntry>;
  let renderer: Promise<RenderMermaid> | null = null;

  /* ---- 渲染互斥与去重 ---- */

  /** 串行队列：mermaid.initialize 是全局状态，必须与 render 处于同一
   *  互斥区，否则并发渲染会互相覆盖主题。 */
  let renderChain: Promise<unknown> = Promise.resolve();
  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    // 前一个任务无论成败都继续执行下一个（fn 内部已 try/catch，
    // 这里做防御性处理）
    const run = renderChain.then(fn, fn);
    renderChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** 同 key 在途渲染去重：多实例同时挂载同一图表时复用同一 promise。 */
  const inflight = new Map<string, Promise<MermaidEntry>>();

  /** 从各渲染器抛出的异常中提取可读错误文案（字符串）。 */
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

  /** 惰性加载 mermaid 并构建渲染函数（模块级单例；render id 全局自增防碰撞） */
  async function getRenderer(): Promise<RenderMermaid> {
    if (!renderer) {
      renderer = (async () => {
        const mermaid = (await import("mermaid")).default;
        let seq = 0;
        return (code: string, themeId: ThemeId): Promise<MermaidEntry> => {
          // in-flight key 与组件缓存键同口径（推断主题 + 源码）
          const key = mermaidCacheKey(
            inferMermaidTheme(getTheme(themeId)),
            code,
          );
          const existing = inflight.get(key);
          if (existing) return existing;

          const p = enqueue(async () => {
            try {
              const { theme } = buildMermaidConfig(themeId);
              // initialize 每次渲染前调用：主题切换后更新全局配置。
              // 串行队列保证 initialize + render 不被其他渲染交错覆盖。
              mermaid.initialize({
                startOnLoad: false,
                securityLevel: "strict",
                suppressErrorRendering: true,
                theme,
              });
              const { svg } = await mermaid.render(`mermaid-${++seq}`, code);
              return { svg, error: null };
            } catch (e) {
              return { svg: null, error: extractErrorMessage(e) };
            } finally {
              inflight.delete(key);
            }
          });
          inflight.set(key, p);
          return p;
        };
      })();
      // 初始化失败（动态 import 失败）时重置，允许后续挂载重试；
      // 原 rejection 仍抛给当前调用方（组件层会兜底）。
      renderer.catch(() => {
        renderer = null;
      });
    }
    return renderer;
  }
</script>

<script lang="ts">
  /**
   * Mermaid 图表组件（MarkdownNode 对 pre>code.language-mermaid 的分派产物）。
   *
   * 占位状态机（对齐 MarkdownMath / MarkdownImage）：
   *   · parsing：缓存未命中且从未有内容 → 字面量淡化；
   *   · updating：块更新（主题/源码变化触发重渲染）→ 旧 SVG 继续显示、
   *     淡化（旧内容为错误占位时退回字面量）；
   *   · error：图表语法错误终态 → 八边形感叹号 + 提示文本，详情进 title；
   *   · ready：SVG 正常显示。
   *
   * 【seq 语义】每次 effect run 都无条件 ++seq，使上一次 effect run 启动
   * 的 async 通过 mySeq !== seq 可靠过期；否则命中缓存时 seq 不前进，
   * 旧 async 会把 lastShown 污染为旧 code 的渲染结果。
   *
   * 【firstRun】实例级首帧标志：首次 effect run 直发（0ms），此后走
   * 250ms 防抖。用实例标志而非 seq 判断，避免虚拟滚动重挂载（seq 已
   * 非 1）时首次也走防抖。
   */
  import { get } from "svelte/store";
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

  /** 推断出的 mermaid 主题（重渲染的唯一主题依据） */
  const mTheme = $derived(inferMermaidTheme(getTheme($theme)));

  let cacheVersion = $state(0);

  /* $derived 内必须用纯查询（peek）：get 会刷新 LRU，属于副作用。 */
  const cached = $derived.by(() => {
    void cacheVersion; // 订阅：缓存写入后触发重算
    if (!code.trim()) return null;
    return mermaidCachePeek(mermaidCacheKey(mTheme, code)) ?? null;
  });

  let lastShown = $state<MermaidEntry | null>(null);

  let seq = 0;
  let firstRun = true;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  /* effect cleanup 后置 true：跳过对已销毁实例的状态写入。
     注意缓存本身仍会写入（跨实例共享，下次挂载可命中）。 */
  let disposed = false;

  type MermaidPhase = "ready" | "error" | "updating" | "parsing";
  const phase = $derived<MermaidPhase>(
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
      ? $t("preview.mermaidRenderFailed") + cached.error
      : undefined,
  );

  $effect(() => {
    disposed = false;
    /* 无条件递增：保证上一次 effect run 启动的 async 通过 mySeq !== seq
       可靠过期；命中缓存不启动新 async 时，也要让旧 async 失效。 */
    const mySeq = ++seq;
    const immediate = firstRun;
    firstRun = false;

    const mt = mTheme;
    const src = code;
    if (!src.trim()) {
      /* 空源码：清空 lastShown，避免旧 SVG 残留 */
      lastShown = null;
      return;
    }

    const hit = mermaidCacheGet(mermaidCacheKey(mt, src));
    if (hit) {
      lastShown = hit;
      return;
    }

    debounceTimer = setTimeout(
      () => {
        void (async () => {
          // 防抖等待期其他实例可能已完成同一 key 的渲染并写入缓存，复用
          const again = mermaidCacheGet(mermaidCacheKey(mt, src));
          if (again) {
            if (mySeq !== seq) return;
            lastShown = again;
            if (!disposed) cacheVersion++;
            return;
          }
          let r: MermaidEntry;
          try {
            // 非响应式读取 themeId 传入 render（render 内部仅用于推断主题，
            // 与 effect 依赖的 mTheme 同源）
            const render = await getRenderer();
            r = await render(src, get(theme));
          } catch (e) {
            // getRenderer 初始化失败兜底：否则 unhandled rejection 且
            // 组件永久停留 parsing
            r = { svg: null, error: extractErrorMessage(e) };
          }
          if (mySeq !== seq) return;
          mermaidCacheSet(mermaidCacheKey(mt, src), r);
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
    const text = code.endsWith('\n') ? code.slice(0, -1) : code;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
      if (copiedTimer !== undefined) clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => (copied = false), 1500);
    } catch {}
  }
</script>

<div class="mermaid-wrap">
  {#if phase === "ready"}
    <div class="mermaid-svg">{@html cached?.svg}</div>
  {:else if phase === "error"}
    <!-- 错误终态：参照 MarkdownImage 失败占位符 -->
    <div class="mermaid-err-ph" title={errorTitle}>
      <svg
        class="mermaid-err-ic"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.7"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path
          d="M20.32 15.44 15.44 20.32H8.56L3.68 15.44V8.56L8.56 3.68H15.44L20.32 8.56Z"
        />
        <path d="M12 7.5v6" />
        <circle cx="12" cy="16.5" r="0.8" fill="currentColor" stroke="none" />
      </svg>
      <span class="mermaid-err-t">{$t("preview.mermaidFailed")}</span>
    </div>
  {:else if phase === "updating"}
    <!-- 块更新：旧 SVG 继续显示、淡化；旧内容为错误占位时退回字面量 -->
    {#if lastShown?.svg}
      <div class="mermaid-svg md-skel">{@html lastShown.svg}</div>
    {:else}
      <div class="mermaid-lit md-skel">{code}</div>
    {/if}
  {:else}
    <!-- 解析中：源码字面量淡化 -->
    <div class="mermaid-lit md-skel">{code}</div>
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
  /* 【块背景色】与 .md-block pre（代码块）同款：恒有背景 + 边框 */
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

  /* 字面量（解析中 / 块更新的错误回退）：淡化 + 保留源码排版 */
  .mermaid-lit {
    color: var(--pv-muted);
    white-space: pre-wrap;
    word-break: break-all;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.85em;
  }

  /* 错误占位符（参照 MarkdownImage 块级失败态：图标 + 文本，居中排布） */
  .mermaid-err-ph {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    min-height: 120px;
    color: var(--pv-muted);
    cursor: help;
  }

  .mermaid-err-ic {
    width: 24px;
    height: 24px;
    flex: none;
  }

  .mermaid-err-t {
    font-size: 0.9em;
  }

  /* 占位淡化（与 MarkdownMath 同款）：仅降低不透明度，不引入扫光动画 */
  .md-skel {
    opacity: 0.45;
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
