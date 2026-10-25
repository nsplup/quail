<script lang="ts">
  /**
   * 预览代码块组件（MarkdownNode 对 pre>code 的分派产物）。
   *
   * - 按需：预览为虚拟滚动，组件挂载即处于/接近视口 → 挂载时直接发起解析
   *   请求；首帧渲染纯文本（与着色后文本完全一致，零布局跳动），结果到达
   *   后替换为着色 HTML；
   * - 防打字洪峰：代码文本变化 → debounce 250ms 再请求；首次挂载 / 文本未
   *   变的重挂载（滚动往返）直发，worker 内存缓存即时命中；
   * - 无缓存状态：缓存权威在 worker（内容寻址 hash → 单级内存 LRU，无持久化），
   *   同一代码块编辑 N 次 = N 个不同键各一条记录，无重复副本；
   * - 降级：未标注语言 / 语言包缺失 / 超大块 / worker 不可用 → 恒为纯文本。
   *
   * 安全：着色 HTML 为 highlight.js 输出——代码文本全程转义、仅含 class
   * 标记的 span（围栏内容在 mdast 中为纯文本，无标记注入通道）。
   * 纯文本 / 搜索 mark 路径在本组件内统一 escapeHtml 后拼接。
   *
   * 格式解耦：<code> 内部不写任何模板字面量，内容全部由 $effect 经 innerHTML
   * 写入；<pre> 与 <code> 之间被 formatter 插入的空白文本节点也会被清除。
   * 因此本文件可被任意 formatter（Prettier / dprint / biome…）正常格式化，
   * 不会把缩进/换行泄漏进 <pre> 内容。
   */
  import type { Element } from "hast";
  import Icon from "../../components/Icon.svelte";
  import { t } from "../i18n.svelte";
  import { hastAttrs } from "../markdown/hast-attrs";
  import { requestHighlight } from "./hl-client";
  import {
    previewSearchState$ as previewSearchState,
    extractMarkRanges,
    injectMarksIntoHtml,
  } from "../preview/previewSearch";

  let { node }: { node: Element } = $props();

  /* ---------- 复制按钮（默认隐藏，悬停代码块时显示；显隐用 visibility，不用 opacity） ---------- */
  let copied = $state(false);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;

  async function copyCode(): Promise<void> {
    const ok = await writeClipboard(plain);
    if (!ok) return;
    copied = true;
    if (copiedTimer !== undefined) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copied = false), 1500);
  }

  /** 剪贴板写入：优先 Clipboard API，不可用（如 webkitgtk 旧版）时回退 execCommand */
  function writeClipboard(text: string): Promise<boolean> {
    if (navigator.clipboard?.writeText) {
      return navigator.clipboard.writeText(text).then(
        () => true,
        () => writeClipboardFallback(text),
      );
    }
    return Promise.resolve(writeClipboardFallback(text));
  }

  function writeClipboardFallback(text: string): boolean {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px"; // 移出视口而非 visibility/opacity 隐藏（需可选中）
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }

  /** pre 的直接子 code 元素（分派方保证存在） */
  const codeEl = $derived(
    node.children.find(
      (c): c is Element => c.type === "element" && c.tagName === "code",
    ),
  );

  function classList(el: Element | undefined): string[] {
    const cls = el?.properties?.className;
    return (Array.isArray(cls) ? cls : cls != null ? [String(cls)] : []).map(
      String,
    );
  }

  /** 围栏信息串语言（class="language-x"，小写；无标注 = ""） */
  const lang = $derived.by(() => {
    for (const c of classList(codeEl)) {
      const m = /language-([\w#+.-]+)/.exec(c);
      if (m) return m[1].toLowerCase();
    }
    return "";
  });

  function collectText(el: Element | undefined): string {
    if (!el) return "";
    let out = "";
    for (const c of el.children) {
      if (c.type === "text") out += c.value;
      else if (c.type === "element") out += collectText(c);
    }
    return out;
  }

  /** 代码原文（code 元素文本；空串不发请求） */
  const plain = $derived(collectText(codeEl));

  /** code 元素原有 class（保留 language-x 标注，叠加 hljs） */
  const codeClass = $derived(["hljs", ...classList(codeEl)].join(" "));

  /** 着色 HTML；null = 未着色（纯文本展示） */
  let html = $state<string | null>(null);

  /* ---------- 查找高亮接回（searchPanel / previewSearch 装饰器） ---------- */

  /** 装饰器切进 code 子树的 mark 区间（plain 文本偏移口径；面板关闭/无命中为空） */
  const matchRanges = $derived(extractMarkRanges(codeEl));
  const searchCurrent = $derived($previewSearchState.current);
  const hasMarks = $derived(matchRanges.length > 0);

  /** 着色路径：向 hljs 输出注入 mark；无命中时原样返回 html */
  const markedHtml = $derived(
    html !== null && hasMarks
      ? injectMarksIntoHtml(html, matchRanges, searchCurrent)
      : html,
  );

  /** 纯文本路径（首帧 / 降级）：按区间分片渲染 mark（文本内容与 plain 完全一致） */
  const plainPieces = $derived.by(() => {
    if (html !== null || !hasMarks) return null;
    const pieces: Array<{ text: string; id: number; cur: boolean }> = [];
    let pos = 0;
    for (const r of matchRanges) {
      if (r.start > pos)
        pieces.push({ text: plain.slice(pos, r.start), id: -1, cur: false });
      pieces.push({
        text: plain.slice(r.start, r.end),
        id: r.id,
        cur: r.id === searchCurrent,
      });
      pos = r.end;
    }
    if (pos < plain.length)
      pieces.push({ text: plain.slice(pos), id: -1, cur: false });
    return pieces;
  });

  let seq = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    const l = lang;
    const code = plain;
    const mySeq = ++seq;
    html = null; // 内容/语言变化立即回纯文本（首次挂载本就是 null）
    if (l === "" || code.length === 0) return;
    // 首次挂载直发（大概率缓存命中）；文本变化走防抖（打字过程不打出请求洪峰）
    const delay = mySeq === 1 ? 0 : 250;
    debounceTimer = setTimeout(() => {
      void (async () => {
        const r = await requestHighlight(l, code);
        if (mySeq !== seq) return; // 期间已有更新请求，丢弃过期结果
        html = r; // string | null（null = 降级，维持纯文本）
      })();
    }, delay);
    return () => clearTimeout(debounceTimer);
  });

  /* ---------- 模板内容写入（与格式化无关） ---------- */

  function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) =>
      c === "&"
        ? "&amp;"
        : c === "<"
          ? "&lt;"
          : c === ">"
            ? "&gt;"
            : c === '"'
              ? "&quot;"
              : "&#39;",
    );
  }

  /** code 的最终 HTML：着色 / 带 mark 的纯文本 / 纯文本，三者互斥 */
  const contentHtml = $derived.by(() => {
    if (html !== null) return markedHtml ?? "";
    if (plainPieces) {
      let out = "";
      for (const p of plainPieces) {
        if (p.id >= 0) {
          out += `<mark class="pv-search-hl${p.cur ? " pv-search-current" : ""}" data-mid="${p.id}">${escapeHtml(p.text)}</mark>`;
        } else {
          out += escapeHtml(p.text);
        }
      }
      return out;
    }
    return escapeHtml(plain);
  });

  let codeRef = $state<HTMLElement | undefined>(undefined);

  $effect(() => {
    const content = contentHtml;
    const code = codeRef;
    if (!code) return;
    code.innerHTML = content;
    // formatter 可能在 <pre> 与 <code> 之间插入空白文本节点：清掉，避免污染内容
    const pre = code.parentElement;
    if (pre) {
      for (const child of Array.from(pre.childNodes)) {
        if (child !== code) child.remove();
      }
    }
  });
</script>

<div class="codeblock-wrap">
  <pre {...hastAttrs(node)}><code bind:this={codeRef} class={codeClass}
    ></code></pre>
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
  .codeblock-wrap {
    position: relative;
  }

  /* 默认隐藏（visibility 而非 opacity），悬停代码块或按钮聚焦时显示 */
  .code-copy-btn {
    position: absolute;
    top: 8px;
    right: 8px;
    z-index: 1;
    display: inline-flex;
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
    /* visibility 的离散过渡：隐藏延迟到过渡结束，显隐均有时间窗且不触碰 opacity */
    transition:
      visibility 0.15s,
      color 0.15s,
      border-color 0.15s;
  }

  .codeblock-wrap:hover .code-copy-btn,
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
