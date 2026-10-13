<script lang="ts">
  /**
   * HAST 节点递归渲染组件（Svelte 5 自导入实现递归）。
   *
   * - element → svelte:element 动态标签（属性经 hastAttrs 映射 className→class 等）；
   * - md-image（编译期 image handler 的产物）→ MarkdownImage 组件
   *   （三态 / 懒加载 / restricted 判定，行为等价旧自定义元素）；
   * - text → 文本节点（值原样输出，空格/换行由 CSS white-space 控制）；
   * - comment / doctype → 不渲染；
   * - raw → 显式忽略并 warn（指南方案 B 兜底；管线 rehype-raw 融合后不应出现）。
   *
   * 增量更新：node 引用未变（增量解析 head/tail 段复用）时 Svelte 跳过该子树；
   * 引用变化但结构相同（同为 paragraph 等）时复用 DOM，仅更新差异文本/属性——
   * md-image 组件实例不销毁，图片不重新请求。
   */
  import type { Element, RootContent, Text } from "hast";
  import MarkdownImage from "./MarkdownImage.svelte";
  import MarkdownNode from "./MarkdownNode.svelte"; // 自导入实现递归（Svelte 5 不支持隐式自引用）
  import CodeBlock from "../highlight/CodeBlock.svelte";
  import { hastAttrs } from "./hast-attrs";

  let { node }: { node: RootContent } = $props();

  /** HTML void 元素：无内容模型。hast 中它们 children 恒为空，但若仍走
   *  带 {#each} 子内容的 svelte:element 分支，Svelte 5 运行时会因
   *  「void 元素携带内容片段」持续输出 dynamic_void_element_content 警告，
   *  故单独走无子内容的自闭合分支。 */
  const VOID_ELEMENTS = new Set([
    "area",
    "base",
    "br",
    "col",
    "embed",
    "hr",
    "img",
    "input",
    "link",
    "meta",
    "param",
    "source",
    "track",
    "wbr",
  ]);

  $effect(() => {
    if (node.type === "raw") {
      console.warn("[MarkdownNode] raw 节点未渲染（管线应已由 rehype-raw 融合）");
    }
  });
</script>

{#if node.type === "element"}
  {#if (node as Element).tagName === "md-image"}
    <!-- data-inline 由管线标注：块级（独立成段，含 <a> 包裹）不标注，行内 = "1" -->
    <MarkdownImage
      src={((node as Element).properties?.["data-src"] ??
        (node as Element).properties?.dataSrc ??
        "") as string}
      alt={((node as Element).properties?.["data-alt"] ??
        (node as Element).properties?.dataAlt ??
        "") as string}
      inline={(node as Element).properties?.["data-inline"] === "1"}
    />
  {:else if (node as Element).tagName === "pre" &&
      (node as Element).children.some((c) => c.type === "element" && c.tagName === "code")}
    <!-- 围栏代码块（pre>code）→ CodeBlock（着色 worker + 内容寻址缓存）；
         其余 pre（无 code 子元素，如 raw HTML 场景）走通用分支 -->
    <CodeBlock node={node as Element} />
  {:else if VOID_ELEMENTS.has((node as Element).tagName)}
    <!-- void 元素：无子内容，自闭合渲染（避免 dynamic_void_element_content 警告） -->
    <svelte:element this={(node as Element).tagName} {...hastAttrs(node as Element)} />
  {:else}
    <svelte:element this={(node as Element).tagName} {...hastAttrs(node as Element)}>
      {#each (node as Element).children as child}
        <MarkdownNode node={child} />
      {/each}
    </svelte:element>
  {/if}
{:else if node.type === "text"}
  {(node as Text).value}
{:else if node.type === "comment" || node.type === "doctype"}
  <!-- 不渲染 -->
{/if}
