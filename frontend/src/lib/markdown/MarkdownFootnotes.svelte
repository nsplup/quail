<script lang="ts">
  /**
   * 脚注列表组件（文档末尾，随内容滚动）——只从全局 STORE 订阅列表内容。
   * ...（原注释全部保留）
   *
   * 【回链内联】最后一个子节点为段落（<p>）时，回链通过 MarkdownNode 的
   * trailing snippet 渲染在段落末尾（inline 内容，紧跟脚注文字，不另起
   * 一行）；若最后一块为非段落块（表格 / 列表 / 代码块 / 引用等），回链
   * 作为独立块尾随其后——这些容器无法可靠承载任意 inline 内容。
   */
  import type { Element } from "hast";
  import MarkdownNode from "./MarkdownNode.svelte";
  import { footnoteList$ } from "./reference-store";
  import { t } from "../i18n.svelte";

  const items = $derived($footnoteList$);
</script>

{#snippet backrefs(fn: (typeof items)[number])}
  <span class="md-footnotes-backrefs">
    {#each Array(fn.count) as _, k (k)}
      <a
        class="md-footnotes-backref"
        href={`#fnref:${fn.number}:${k + 1}`}
        aria-label={$t("footnotes.back", { values: { n: k + 1 } })}
      >
        <svg
          class="md-footnotes-backref-icon"
          width="1em"
          height="1em"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <polyline points="9 14 4 9 9 4"></polyline>
          <path d="M20 20v-7a4 4 0 0 0-4-4H4"></path>
        </svg>
        {#if fn.count > 1}
          <sup class="md-footnotes-backref-n">{k + 1}</sup>
        {/if}
      </a>
    {/each}
  </span>
{/snippet}

{#if items.length}
  <section class="md-footnotes" data-footnotes aria-labelledby="md-footnotes-title">
    <h2 class="md-footnotes-title" id="md-footnotes-title">{$t("footnotes.title")}</h2>
    <ol class="md-footnotes-list">
      {#each items as fn (fn.identifier)}
        <li
          class="md-footnotes-item"
          id={`fn-${fn.number}`}
          data-fn-index={fn.number}
          data-fn-id={fn.identifier}
        >
          {#each fn.def.children as child, i (`fi-${fn.identifier}-${i}`)}
            {@const isLast = i === fn.def.children.length - 1}
            {@const isPara =
              child.type === "element" &&
              (child as Element).tagName === "p"}
            {#if isLast && isPara && fn.count > 0}
              <!-- 回链内联在段落末尾（跟脚注文字同行，空间不足随文字换行） -->
              <MarkdownNode node={child} blockIndex={-1}>
                {#snippet trailing()}
                  {@render backrefs(fn)}
                {/snippet}
              </MarkdownNode>
            {:else}
              <MarkdownNode node={child} blockIndex={-1} />
              {#if isLast && fn.count > 0}
                <!-- 最后一块不是段落：回链作为独立块尾随 -->
                {@render backrefs(fn)}
              {/if}
            {/if}
          {/each}
        </li>
      {/each}
    </ol>
  </section>
{/if}