<script lang="ts">
  /**
   * HAST 节点递归渲染组件（Svelte 5 自导入实现递归）。
   * ...（原注释全部保留）
   *
   * 【trailing snippet】可选的内联尾部内容（如脚注回链）。仅在当前节点
   * 自身是 <p> 时渲染在段落最后一个子节点之后；子节点递归时不透传，
   * 因此不会扩散到内层段落 / 其它元素。
   */
  import type { Element, RootContent, Text } from "hast";
  import type { Snippet } from "svelte";
  import MarkdownImage from "./MarkdownImage.svelte";
  import MarkdownFootnoteRef from "./MarkdownFootnoteRef.svelte";
  import MarkdownLinkRef from "./MarkdownLinkRef.svelte";
  import MarkdownNode from "./MarkdownNode.svelte"; // 自导入实现递归（Svelte 5 不支持隐式自引用）
  import EditableTable from "./EditableTable.svelte";
  import EditableCheckbox from "./EditableCheckbox.svelte";
  import Accordion from "./Accordion.svelte";
  import CodeBlock from "../highlight/CodeBlock.svelte";
  import MarkdownMath from "./MarkdownMath.svelte";
  import MermaidBlock from "./MermaidBlock.svelte";
  import { hastAttrs } from "./hast-attrs";
  import { previewSearchState$ as previewSearchState } from "../preview/previewSearch";

  let {
    node,
    blockIndex = null,
    inTaskItem = false,
    accordionParentKey = null,
    trailing,
  }: {
    node: RootContent;
    blockIndex?: number | null;
    /** 当前节点是否处于 task-list-item 的内容上下文（含其段落内） */
    inTaskItem?: boolean;
    /**
     * 外层折叠面板的 key（仅 details 子树内传递；嵌套 Accordion 组合父 key，
     * 避免内外层 summary 相同 → 共享折叠记录导致点击互扰 / 状态回弹）。
     */
    accordionParentKey?: string | null;
    /**
     * 可选：追加在当前 <p> 段落末尾的内联内容（如脚注回链）。
     * 仅当本节点自身是 <p> 时渲染；不会传递给子节点。
     */
    trailing?: Snippet;
  } = $props();

  /** GFM 任务列表项（remark-gfm 给 li 注入 task-list-item 类，themes.css 同款判定） */
  const isTaskListItem = (n: RootContent): boolean =>
    n.type === "element" &&
    (n as Element).tagName === "li" &&
    ((n as Element).properties?.className as unknown[] | undefined)?.includes(
      "task-list-item",
    ) === true;

  /** 任务项内的勾选框 input（tight 为 li 直接子元素，loose 在 li > p 内） */
  const isTaskCheckbox = (n: RootContent): boolean =>
    n.type === "element" &&
    (n as Element).tagName === "input" &&
    (n as Element).properties?.type === "checkbox";

  /** pre>code 的围栏信息串语言（language-x class 小写；无标注 = ""）。
   *  供 mermaid 围栏分派 MermaidBlock 使用（判定与 CodeBlock.classList 同口径） */
  const fenceLang = (n: RootContent): string => {
    if (n.type !== "element") return "";
    for (const c of (n as Element).children) {
      if (c.type !== "element" || (c as Element).tagName !== "code") continue;
      const cls = (c as Element).properties?.className;
      const list = Array.isArray(cls)
        ? cls.map(String)
        : cls != null
          ? [String(cls)]
          : [];
      const lang = list.find((v) => v.startsWith("language-"));
      return lang ? lang.slice("language-".length).toLowerCase() : "";
    }
    return "";
  };

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

  /** 通用 element 的 children 是否继承任务项上下文：
   *  - p / strong / em / a 等保持（loose 任务项 checkbox 在 p 内）；
   *  - li / ul / ol 重置（嵌套列表由各自的 li.task-list-item 重新判定） */
  const childInTaskItem = $derived(
    inTaskItem &&
      node.type === "element" &&
      !["li", "ul", "ol"].includes((node as Element).tagName),
  );

  $effect(() => {
    if (node.type === "raw") {
      console.warn(
        "[MarkdownNode] raw 节点未渲染（管线应已由 rehype-raw 融合）",
      );
    }
  });
</script>

{#if node.type === "element"}
  {#if (node as Element).tagName === "mark"}
    <!-- 查找高亮：装饰器生成的 mark 元素。current class 由 store 响应式驱动，
         切换匹配项时只更新本元素的 class 属性，不触发上游 {#each} 重建 -->
    <mark
      class="pv-search-hl"
      class:pv-search-current={String(
        (node as Element).properties?.["data-mid"],
      ) === String($previewSearchState.current)}
      data-mid={(node as Element).properties?.["data-mid"] as string}
      >{#each (node as Element).children as child, i (`${(node as Element).tagName}-${i}`)}<MarkdownNode
          node={child}
          {blockIndex}
          {accordionParentKey}
        />{/each}</mark
    >
  {:else if inTaskItem && isTaskCheckbox(node)}
    <!-- 任务项 checkbox：tight / loose 均在此分派，模板无需知道父结构 -->
    <EditableCheckbox node={node as Element} {blockIndex} />
  {:else if (node as Element).tagName === "img"}
    <!-- 图片统一入口：image / imageReference handler 与 raw HTML 归一化
         （normalizeHtmlImages）的产物均为 img + data-*（不再有 md-image
         中间标签）；引用式图片（data-ref-identifier）由组件从全局 STORE
         解析，不可用时显示字面量。data-inline 由管线标注：块级（独立
         成段，含 <a> 包裹）不标注，行内 = "1" -->
    <MarkdownImage node={node as Element} />
  {:else if (node as Element).tagName === "md-footnote-ref"}
    <!-- 脚注引用（[^label]）：数据层标记 → 组件从 STORE 查找；命中渲染
         上标编号链接（悬停预览 / 跳转脚注列表），未定义显示字面量 -->
    <MarkdownFootnoteRef node={node as Element} />
  {:else if (node as Element).tagName === "md-link-ref"}
    <!-- 链接引用（[text][id]）：数据层标记 → 组件从 STORE 查找；命中且
         url 非空渲染 <a>，否则字面量回退 -->
    <MarkdownLinkRef node={node as Element} />
  {:else if (node as Element).tagName === "table"}
    <!-- 所有来源的表格 → 可编辑表格组件（markdown / raw HTML 统一走
         EditableTable；来源经 data-*-table 标记在组件内区分反向更新格式）。
         blockIndex = 段下标，供反向更新定位源码行区间 -->
    <EditableTable node={node as Element} {blockIndex} />
  {:else if (node as Element).tagName === "details"}
    <!-- 折叠面板：<details>/<summary>（markdown 场景为 raw HTML）→ Accordion
         组件渲染（不再走通用 svelte:element 分支输出原生 details 标签）。
         折叠状态：挂载时优先取全局 store（accordionOpen$，虚拟滚动卸载重
         挂载恢复），无记录回落 HAST open 属性；用户切换经组件上报 store。
         嵌套：accordionParentKey 传入父面板 key，Accordion 组合成路径 key -->
    <Accordion
      node={node as Element}
      {blockIndex}
      parentKey={accordionParentKey}
    />
  {:else if (node as Element).tagName === "md-math"}
    <!-- 数学公式（remark-math handler 产物）：md-math 数据层标记 →
         MarkdownMath 组件 MathJax SVG 自渲染（data-display 区分独立块 /
         行内，尺寸行为对齐 MarkdownImage）。查找彻底排除匹配，见
         previewSearch.ts isSearchExcluded -->
    <MarkdownMath node={node as Element} />
  {:else if (node as Element).tagName === "pre" && (node as Element).children.some((c) => c.type === "element" && c.tagName === "code")}
    {#if fenceLang(node) === "mermaid"}
      <!-- mermaid 围栏 → MermaidBlock（SVG 自渲染 + 主题色同步；
           查找彻底排除匹配，见 previewSearch.ts isSearchExcluded） -->
      <MermaidBlock node={node as Element} />
    {:else}
      <!-- 围栏代码块（pre>code）→ CodeBlock；其余 pre 走通用分支 -->
      <CodeBlock node={node as Element} />
    {/if}
  {:else if isTaskListItem(node)}
    <!-- 任务列表项：children 全部在 inTaskItem=true 上下文递归；
         checkbox 由 element 分支最前面的 inTaskItem 分派处理，
         本分支不特判任何子节点 -->
    <li {...hastAttrs(node as Element)}>
      {#each (node as Element).children as child, i (`${(node as Element).tagName}-${i}`)}<MarkdownNode
          node={child}
          {blockIndex}
          inTaskItem={true}
          {accordionParentKey}
        />{/each}
    </li>
  {:else if VOID_ELEMENTS.has((node as Element).tagName)}
    <!-- void 元素：无子内容，自闭合渲染（避免 dynamic_void_element_content 警告） -->
    <svelte:element
      this={(node as Element).tagName}
      {...hastAttrs(node as Element)}
    />
  {:else}
    <svelte:element
      this={(node as Element).tagName}
      {...hastAttrs(node as Element)}
      >{#each (node as Element).children as child, i (`${(node as Element).tagName}-${i}`)}<MarkdownNode
          node={child}
          {blockIndex}
          inTaskItem={childInTaskItem}
          {accordionParentKey}
        />{/each}{#if trailing && (node as Element).tagName === "p"}{@render trailing()}{/if}</svelte:element
    >
  {/if}
{:else if node.type === "text"}
  {(node as Text).value}
{:else if node.type === "comment" || node.type === "doctype"}
  <!-- 不渲染 -->
{/if}
