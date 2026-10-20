<script lang="ts">
  /**
   * 预览段渲染器：VList 的单个虚拟项（一个 HAST 段）。
   *
   * - 段容器按索引复用：worker 增量只重发被替换区间，未变段对象引用不变 →
   *   MarkdownNode 递归组件按 props 引用相等跳过子树——文本变化只更新
   *   文本节点，md-image 组件实例不重建、图片不重新请求；
   * - 滚动离开视口的段被虚拟化卸载、滚回时重新挂载：Svelte 组件状态
   *   重建，但节点引用复用使重建仅限当前段子树（overscan 进一步摊薄频率）。
   */
  import type { HastSegment } from "./markdown-core";
  import MarkdownNode from "./MarkdownNode.svelte";

  let { seg, index }: { seg: HastSegment; index: number } = $props();
</script>

<!-- index===0 首块顶间距：虚拟化后 .md-item 不再是滚动容器的直接子元素，
     原 `.preview-scroll > .md-item:first-child` 选择器失效，改为类标记
     （规则见 themes.css） -->
<div class="md-item" class:md-first={index === 0} data-btype={seg.type} data-index={index}>
  <article class="md-block">
    {#each seg.nodes as node}
      <!-- index 即块下标（segments 与 blocks 一一对应），透传给可编辑表格
           等需要源码定位的组件 -->
      <MarkdownNode {node} blockIndex={index} />
    {/each}
  </article>
</div>
