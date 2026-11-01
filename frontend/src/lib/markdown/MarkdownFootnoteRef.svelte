<script lang="ts">
  /**
   * 脚注引用（[^label]）渲染组件——md-footnote-ref 数据层标记的消费方。
   *
   * - 从全局 STORE（reference-store）查找定义：命中 → 上标编号链接
   *   （编号 = 首次引用顺序，GFM 语义），点击经预览区点击委托跳转
   *   脚注列表项（href 自定义锚 #fn:N，见 PreviewPane 跳转系统）；
   * - 引用不可用（STORE 无该定义，如引用了不存在的 label）→ 显示字面量
   *   `[^label]` 纯文本（label 为原始书写形式，任意 Unicode 原样）；
   * - 悬停预览：延时 ~250ms 弹出定义内容的浮层（上下自适应 / 视口内
   *   夹取 / max-height 40vh），内容经 MarkdownNode 递归渲染——内层
   *   md-footnote-ref 标记同样映射本组件 → 嵌套脚注的悬停预览自然支持；
   *   Esc / 滚动 / 指针离开（含 120ms 容忍间隙）关闭；
   * - 增量一致性：标记只携带 identifier/label，编号与可用性全部渲染期
   *   从 STORE 派生 → 增量解析复用的 head/tail 段引用永不陈旧。
   *
   * 【渲染点约定】与 MarkdownNode 一致：children 渲染为
   * 「{#each} 内单一 <MarkdownNode>」，块体为单一组件。
   */
  import MarkdownNode from "./MarkdownNode.svelte";
  import type { Element as HastElement } from "hast";
  import { readRefProp } from "./markdown-core";
  import { footnoteById$, footnoteNumberById$ } from "./reference-store";
  import { t } from "../i18n.svelte";

  let {
    node,
  }: {
    /** HAST md-footnote-ref 标记元素（properties: data-identifier / data-label） */
    node: HastElement;
  } = $props();

  const identifier = $derived(readRefProp(node, "data-identifier"));
  const label = $derived(readRefProp(node, "data-label"));

  /** 定义命中（未定义引用 → 字面量回退） */
  const def = $derived($footnoteById$.get(identifier));
  /** 编号（首现引用顺序 + 1；无引用记录 = 未编号，防御性回退字面量） */
  const number = $derived($footnoteNumberById$.get(identifier));

  /* ---------------- 悬停预览 ---------------- */

  /** 悬停延时（ms）：过滤快速划过 */
  const HOVER_DELAY = 250;
  /** 指针离开容忍（ms）：sup → 浮层之间的间隙过渡 */
  const LEAVE_GRACE = 120;

  let open = $state(false);
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let anchorEl = $state<HTMLElement | undefined>(undefined);
  let popStyle = $state("");

  function clearTimers(): void {
    if (openTimer !== undefined) clearTimeout(openTimer);
    if (closeTimer !== undefined) clearTimeout(closeTimer);
    openTimer = undefined;
    closeTimer = undefined;
  }

  /** 计算浮层位置：优先展示在下方，空间不足转上方；左右视口夹取 */
  function computeStyle(): void {
    const el = anchorEl;
    if (!el) return;

    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const GAP = 8;
    const MAX_W = 480;

    // 水平活动范围 = 预览区（不能越过 .pane-preview 进入编辑区）；
    // 单栏 / 找不到预览区时退化为视口。
    const paneEl = el.closest(".pane-preview");
    const paneRect = paneEl ? paneEl.getBoundingClientRect() : null;
    const minX = (paneRect?.left ?? 0) + GAP;
    const maxX = (paneRect?.right ?? vw) - GAP;
    const availW = Math.max(0, maxX - minX);
    const W = Math.min(MAX_W, availW);

    // 两个方向各自可用的横向空间
    const spaceRight = maxX - rect.left; // 左缘贴锚点左缘，向右展开
    const spaceLeft = rect.right - minX; // 右缘贴锚点右缘，向左展开

    let horizontal: string;
    let width = W;

    if (spaceRight >= W) {
      // 右侧放得下：左对齐，向右展开（常规情形）
      horizontal = `left: ${rect.left}px;`;
    } else if (spaceLeft >= W) {
      // 右侧放不下、左侧放得下：右对齐，向左展开（行尾锚点）
      horizontal = `right: ${vw - rect.right}px;`;
    } else if (spaceRight >= spaceLeft) {
      // 两侧都不够 W：选空间大的一侧并收缩宽度（长脚注 + 窄预览区）
      horizontal = `left: ${rect.left}px;`;
      width = Math.max(0, spaceRight);
    } else {
      horizontal = `right: ${vw - rect.right}px;`;
      width = Math.max(0, spaceLeft);
    }

    const below = rect.bottom + 8;
    const above = rect.top - 8;
    const est = 160;
    const top =
      below + est > vh && above - est > 8
        ? `bottom: ${vh - above}px;`
        : `top: ${below}px;`;

    popStyle = `position: fixed; ${top} ${horizontal} max-width: ${width}px;`;
  }

  function scheduleOpen(): void {
    if (closeTimer !== undefined) {
      clearTimeout(closeTimer);
      closeTimer = undefined;
    }
    if (open) return;
    if (openTimer !== undefined) return;
    openTimer = setTimeout(() => {
      openTimer = undefined;
      if (!def) return; // 无内容可预览（字面量态不弹层）
      computeStyle();
      open = true;
    }, HOVER_DELAY);
  }

  function scheduleClose(): void {
    if (openTimer !== undefined) {
      clearTimeout(openTimer);
      openTimer = undefined;
    }
    if (!open) return;
    if (closeTimer !== undefined) clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      closeTimer = undefined;
      open = false;
    }, LEAVE_GRACE);
  }

  function closeNow(): void {
    clearTimers();
    open = false;
  }

  /* Esc 关闭（仅打开时挂监听）；滚动（捕获任意滚动容器）即关：
     滚动后位置语义已失效，重悬停重新计算 */
  $effect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") closeNow();
    };
    const onScroll = (e: Event): void => {
      const t = e.target;
      // 浮层内部滚动（max-height 内滚 / 嵌套浮层 / 浮层内横向滚动块）
      // 不应关闭；只有外部滚动（预览区等）才让定位语义失效
      if (t instanceof Element && t.closest(".md-fnref-pop")) return;
      closeNow();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  });

  // 卸载清理（段被虚拟化卸载时防泄漏）
  $effect(() => {
    return () => clearTimers();
  });
</script>

{#if def && number}
  <!-- 纯悬停宿主（非交互元素）：pointerenter/leave 只服务预览浮层的
       生命周期，交互语义在内层 <a>（可聚焦、有 aria-label） -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <span
    class="md-fnref"
    onpointerenter={scheduleOpen}
    onpointerleave={scheduleClose}
  >
    <sup class="footnote-ref" data-fn-ref={identifier} bind:this={anchorEl}>
      <a
        href={`#fn:${number}`}
        aria-label={$t("footnotes.goto", { values: { n: number } })}
      >
        {number}
      </a>
    </sup>
    {#if open}
      <!-- 浮层渲染在组件子树内（position:fixed 定位），预览区点击委托照常
           捕获其内层链接（跳列表项 / 外链）；嵌套引用的浮层 DOM 更深，
           同 z-index 下后序绘制在上方 -->
      <span
        class="md-fnref-pop"
        role="tooltip"
        style={popStyle}
        onpointerenter={() => {
          if (closeTimer !== undefined) {
            clearTimeout(closeTimer);
            closeTimer = undefined;
          }
        }}
        onpointerleave={scheduleClose}
      >
        {#each def.children as child, i (`fn-${identifier}-${i}`)}
          <MarkdownNode node={child} />
        {/each}
      </span>
    {/if}
  </span>
{:else}
  <!-- 引用不可用：字面量回退（label 原始书写形式） -->
  [^{label}]
{/if}
