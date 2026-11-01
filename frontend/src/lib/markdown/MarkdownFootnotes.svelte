<script lang="ts">
  /**
   * 脚注列表组件（文档末尾，随内容滚动）——只从全局 STORE 订阅列表内容。
   *
   * - 数据来源：reference-store 的 footnoteList$（首次引用顺序、仅被引用
   *   的定义——GFM/GitHub 语义；参考链接定义不进入此列表且无任何渲染路径）；
   * - 嵌套脚注：定义内容经 MarkdownNode 递归渲染——内层 md-footnote-ref
   *   标记映射 MarkdownFootnoteRef（编号同源 / 悬停预览 / 可继续跳转）；
   * - 回链（多次引用可精确跳回）：每项尾部 ↩ × 引用次数，href 自定义锚
   *   `#fnref:N:K`（N = 脚注编号、K = 文档序第 K 次出现）。点击经预览区
   *   点击委托 → 段 HAST 按文档序扫描定位第 K 次出现所在段（虚拟化下 DOM
   *   计数不可靠，HAST 数据为唯一事实源）→ scrollToIndex → 段内元素级
   *   精确修正（见 PreviewPane 跳转系统）；
   * - 列表标题 i18n（footnotes.title）；
   * - 空列表（无被引用的脚注）整节不渲染。
   */
  import MarkdownNode from "./MarkdownNode.svelte";
  import { footnoteList$ } from "./reference-store";
  import { t } from "../i18n.svelte";

  const items = $derived($footnoteList$);
</script>

{#if items.length}
  <section class="md-footnotes" data-footnotes aria-labelledby="md-footnotes-title">
    <!-- 标题沿用 h2 级语义（GitHub 脚注节为 h2；视觉由 themes.css 收敛） -->
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
            <MarkdownNode node={child} blockIndex={-1} />
          {/each}
          {#if fn.count > 0}
            <span class="md-footnotes-backrefs">
              {#each Array(fn.count) as _, k (k)}
                <a
                  class="md-footnotes-backref"
                  href={`#fnref:${fn.number}:${k + 1}`}
                  aria-label={$t("footnotes.back", { values: { n: k + 1 } })}
                >
                  <span aria-hidden="true">↩</span>
                  {#if fn.count > 1}
                    <sup class="md-footnotes-backref-n">{k + 1}</sup>
                  {/if}
                </a>
              {/each}
            </span>
          {/if}
        </li>
      {/each}
    </ol>
  </section>
{/if}
