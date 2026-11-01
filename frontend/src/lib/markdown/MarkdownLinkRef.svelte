<script lang="ts">
  /**
   * 链接引用（[text][id] / [text][] / [text]）渲染组件——md-link-ref 数据层
   * 标记的消费方。
   *
   * - 从全局 STORE（reference-store）查找链接定义：
   *   · 命中且 url 非空 → <a href title> + 链接文本（children 经
   *     MarkdownNode 递归渲染，行内格式保留）；href 经 sanitizeHref
   *     协议白名单自查（组件渲染绕过 HAST sanitize，必须自防 XSS：
   *     仅放行 http(s) / mailto / 页内锚 / 相对路径）；
   *   · 未命中或 url 为空 → 字面量回退：`[` + children 渲染 + `]` + 后缀
   *     （full → `[label]`、collapsed → `[]`、shortcut → 无）。
   *     label 为原始书写形式（CJK 等任意 Unicode 原样）；行内格式保留渲染
   *     （AST 无逐字源码，记号按 referenceType 语义重建）；
   * - 命中时外链点击由预览区点击委托统一处理（系统浏览器打开），
   *   页内锚（#）走既有 scrollToAnchor；
   * - 增量一致性：标记只携带 identifier / label / referenceType，
   *   解析结果渲染期从 STORE 派生 → head/tail 复用段永不陈旧（也修复了
   *   默认 handler 在 chunk 局部转换期间查不到 head/tail 定义而误回退
   *   字面量的问题）。
   */
  import MarkdownNode from "./MarkdownNode.svelte";
  import type { Element as HastElement } from "hast";
  import { readRefProp } from "./markdown-core";
  import { linkDefById$, sanitizeHref } from "./reference-store";

  let {
    node,
  }: {
    /** HAST md-link-ref 标记元素（data-identifier / data-label / data-ref-type） */
    node: HastElement;
  } = $props();

  const identifier = $derived(readRefProp(node, "data-identifier"));
  const label = $derived(readRefProp(node, "data-label"));
  const refType = $derived(readRefProp(node, "data-ref-type"));

  /** 定义命中 */
  const def = $derived($linkDefById$.get(identifier));
  /** 可用链接（定义命中 + url 非空 + 协议白名单放行）；否则字面量回退 */
  const href = $derived(def && def.url ? sanitizeHref(def.url) : null);

  /** 字面量后缀：full → [label]、collapsed → []、shortcut → 无 */
  const literalSuffix = $derived(
    refType === "full" ? `[${label}]` : refType === "collapsed" ? "[]" : "",
  );
</script>

{#if href}
  <a href={href} title={def?.title ?? undefined}>
    {#each node.children as child, i (`lr-${i}`)}
      <MarkdownNode node={child} />
    {/each}
  </a>
{:else}
  <!-- 引用不可用 / 链接为空 / 协议被拒：字面量回退（括号记号重建 + 行内格式保留） -->
  [{#each node.children as child, i (`lr-${i}`)}<MarkdownNode node={child} />{/each}]{literalSuffix}
{/if}
