<script lang="ts">
  /**
   * Markdown 预览渲染器：消费 worker 回传的段列表（HAST 段，不经 HTML 字符串）。
   *
   * - 顶层按段容器渲染（segments 与 blocks 一一对应），滚动同步依赖该结构；
   * - 段容器按索引复用（非 keyed each）：worker 增量只重发被替换区间，
   *   未变段对象引用不变 → MarkdownNode 递归组件按 props 引用相等跳过
   *   子树——文本变化只更新文本节点，md-image 组件实例不重建、图片不重新请求；
   * - 渐进挂载（progressive mount）：rAF 分批推进 visibleCount，单批目标
   *   ~8ms 自适应调批量；全量重建（epoch 变化）重置为 0，增量补丁
   *   （patchHint）只把补丁区间立即纳入可见范围、不清空已有渲染——
   *   避免每次按键整篇重放；
   * - 渲染进度经 onprogress 回报（visibleCount / total），驱动预览遮罩
   *   与底栏进度指示。
   */
  import { tick } from "svelte";
  import type { HastSegment } from "./markdown-core";
  import MarkdownNode from "./MarkdownNode.svelte";

  let {
    segments,
    epoch = 0,
    patchHint = null,
    total = 0,
    onprogress,
  }: {
    segments: HastSegment[];
    /** 全量重建纪元：变化 → 重置渐进状态（增量补丁不清空已有渲染） */
    epoch?: number;
    /** 最近一次增量补丁：{ segStart, segAdded }，变化 → 补丁区间立即可见 */
    patchHint?: { segStart: number; segAdded: number } | null;
    /** 全量解析的完整段数（进度分母；0 时回退 segments.length） */
    total?: number;
    /** 渲染进度回调（visible, effectiveTotal），渲染层状态变化即回报 */
    onprogress?: (visible: number, total: number) => void;
  } = $props();

  let visibleCount = $state(0);
  let batch = 8; // 初始批量，随后按实测耗时自适应

  const effectiveTotal = $derived(Math.max(total, segments.length));

  // 冷启动全量（boot / worker 崩溃重建，epoch 递增）：清零渐进状态重放。
  // 例行全量（阈值/自愈）不递增 epoch，结果由 stores 原子采纳、此处原地 diff
  // （增量补丁同理保留已有渲染）
  $effect(() => {
    void epoch;
    visibleCount = 0;
    batch = 8;
  });

  // 增量补丁到达：补丁区间立即纳入可见范围（打字补丁通常落在已渲染区间内，
  // 原地即时呈现；新尾部若超出可见范围则交给下方渐进循环追赶）
  $effect(() => {
    if (!patchHint) return;
    const end = patchHint.segStart + patchHint.segAdded;
    if (end > visibleCount) visibleCount = end;
  });

  // 段列表收缩（大段删除等）：可见上限不得超出实际段数
  $effect(() => {
    if (visibleCount > segments.length) visibleCount = segments.length;
  });

  // 进度回报：任何影响可见范围的状态变化都收敛一次（含已追平 → idle）
  $effect(() => {
    onprogress?.(Math.min(visibleCount, effectiveTotal), effectiveTotal);
  });

  // 分批推进：rAF + 自适应批量（目标单批 ~8ms：太快放大、太慢缩小）
  $effect(() => {
    const target = segments.length;
    if (visibleCount >= target) return;

    let cancelled = false;
    const step = async (): Promise<void> => {
      if (cancelled) return;
      const start = performance.now();
      visibleCount = Math.min(visibleCount + batch, target);
      await tick(); // 等 Svelte flush + DOM 更新完成
      const elapsed = performance.now() - start;
      if (elapsed < 4) batch = Math.min(batch * 2, 128);
      else if (elapsed > 12) batch = Math.max(batch >> 1, 1);
      if (!cancelled && visibleCount < segments.length) {
        requestAnimationFrame(() => void step());
      }
    };

    requestAnimationFrame(() => void step());
    return () => {
      cancelled = true;
    };
  });
</script>

{#each segments as seg, i}
  {#if i < visibleCount}
    <div class="md-item" data-btype={seg.type} data-index={i}>
      <article class="md-block">
        {#each seg.nodes as node}
          <MarkdownNode {node} />
        {/each}
      </article>
    </div>
  {/if}
{/each}
