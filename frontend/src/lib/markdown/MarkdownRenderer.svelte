<script lang="ts">
  /**
   * Markdown 预览渲染器：直接消费 HAST 根（指南第 1/2 项，不经 HTML 字符串）。
   *
   * - 顶层按 mdl 行号锚切分为渲染段（splitSegments，与 blocksFromHast 的块
   *   一一对应），每段一个 .md-item 容器——滚动同步 / content-visibility
   *   / 大纲索引依赖该结构；
   * - 段容器按索引复用（非 keyed each）：节点级差异交给 MarkdownNode 递归
   *   组件做 Svelte 细粒度更新——文本变化只更新文本节点，md-image 组件
   *   实例不重建，图片不重新请求、不闪烁；
   * - 增量解析（head/tail 段引用复用）时未变化段的 node 引用不变，
   *   Svelte 跳过其子树更新，整体更新成本 O(变化段)。
   */
  import type { Root as HastRoot } from "hast";
  import { splitSegments } from "../markdown";
  import MarkdownNode from "./MarkdownNode.svelte";

  let { hast }: { hast: HastRoot | null } = $props();

  const segments = $derived(hast ? splitSegments(hast) : []);
</script>

{#each segments as seg, i}
  <div class="md-item" data-btype={seg.type} data-index={i}>
    <article class="md-block">
      {#each seg.nodes as node}
        <MarkdownNode {node} />
      {/each}
    </article>
  </div>
{/each}
