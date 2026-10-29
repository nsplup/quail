<script lang="ts">
  /**
   * HAST 节点递归渲染组件（Svelte 5 自导入实现递归）。
   *
   * - element → svelte:element 动态标签（属性经 hastAttrs 映射 className→class 等）；
   * - md-image（编译期 image handler 的产物）→ MarkdownImage 组件
   *   （三态 / 懒加载 / restricted 判定，行为等价旧自定义元素）；
   * - table（markdown / raw HTML，来源经 data-*-table 标记）→ EditableTable
   *   可编辑表格组件（HAST 显示 + 反向更新编辑区，见组件头注释）；
   * - details（raw HTML 折叠面板）→ Accordion 组件（折叠状态经全局
   *   store 记忆：挂载优先取 store，回落 HAST open 属性，见组件头注释）；
   * - pre>code（围栏代码块）→ CodeBlock（着色 worker + 内容寻址缓存）；
   * - task-list-item 内的 checkbox（tight: li>input / loose: li>p>input）
   *   → EditableCheckbox；
   * - text → 文本节点（值原样输出，空格/换行由 CSS white-space 控制）；
   * - comment / doctype → 不渲染；
   * - raw → 显式忽略并 warn（指南方案 B 兜底；管线 rehype-raw 融合后不应出现）。
   *
   * 【结构无关渲染】children 渲染点统一为「{#each} 内单一 <MarkdownNode>」，
   * 任务 checkbox 的分派由 inTaskItem prop 驱动、在 element 分支最前面完成，
   * 不再在 li / p 分支里与相邻节点混排。{#if} / {#each} 的锚点是注释（不占宽），
   * 块体为单一组件 → Prettier 等格式化工具写不写换行、写不写空格都不会产生
   * 模板空白 text node，输出 DOM 与模板排版无关。
   *
   * 【inTaskItem 传递】li.task-list-item → children 传 true；
   * 通用 element 在非 li/ul/ol 时继承（p / strong / em / a 等）；
   * 遇 li/ul/ol 重置为 false（嵌套列表由各自的 li.task-list-item 重新判定）。
   *
   * 【accordionParentKey 传递】details 子树（summary / content）内所有
   * 递归渲染点透传 accordionParentKey，遇到内层 details 时交由 Accordion
   * 组合成 "外层H/内层H" 路径 key——解决嵌套折叠面板 summary 相同导致
   * 共享折叠记录、内外层互相覆盖的问题。details 子树之外的节点忽略此 prop
   * （传 undefined 等价于顶层，行为不变）。
   *
   * 增量更新：node 引用未变（增量解析 head/tail 段复用）时 Svelte 跳过该子树；
   * 引用变化但结构相同（同为 paragraph 等）时复用 DOM，仅更新差异文本/属性——
   * md-image 组件实例不销毁，图片不重新请求。
   */
  import type { Element, RootContent, Text } from "hast";
  import MarkdownImage from "./MarkdownImage.svelte";
  import MarkdownNode from "./MarkdownNode.svelte"; // 自导入实现递归（Svelte 5 不支持隐式自引用）
  import EditableTable from "./EditableTable.svelte";
  import EditableCheckbox from "./EditableCheckbox.svelte";
  import Accordion from "./Accordion.svelte";
  import CodeBlock from "../highlight/CodeBlock.svelte";
  import { hastAttrs } from "./hast-attrs";
  import { previewSearchState$ as previewSearchState } from "../preview/previewSearch";

  let {
    node,
    blockIndex = null,
    inTaskItem = false,
    accordionParentKey = null,
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
    >
      {#each (node as Element).children as child, i (`${(node as Element).tagName}-${i}`)}
        <MarkdownNode node={child} {blockIndex} accordionParentKey={accordionParentKey} />
      {/each}
    </mark>
  {:else if inTaskItem && isTaskCheckbox(node)}
    <!-- 任务项 checkbox：tight / loose 均在此分派，模板无需知道父结构 -->
    <EditableCheckbox node={node as Element} {blockIndex} />
  {:else if (node as Element).tagName === "md-image"}
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
  {:else if (node as Element).tagName === "pre" && (node as Element).children.some((c) => c.type === "element" && c.tagName === "code")}
    <!-- 围栏代码块（pre>code）→ CodeBlock；其余 pre 走通用分支 -->
    <CodeBlock node={node as Element} />
  {:else if isTaskListItem(node)}
    <!-- 任务列表项：children 全部在 inTaskItem=true 上下文递归；
         checkbox 由 element 分支最前面的 inTaskItem 分派处理，
         本分支不特判任何子节点 -->
    <li {...hastAttrs(node as Element)}>
      {#each (node as Element).children as child, i (`${(node as Element).tagName}-${i}`)}
        <MarkdownNode
          node={child}
          {blockIndex}
          inTaskItem={true}
          accordionParentKey={accordionParentKey}
        />
      {/each}
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
    >
      {#each (node as Element).children as child, i (`${(node as Element).tagName}-${i}`)}
        <MarkdownNode
          node={child}
          {blockIndex}
          inTaskItem={childInTaskItem}
          accordionParentKey={accordionParentKey}
        />
      {/each}
    </svelte:element>
  {/if}
{:else if node.type === "text"}
  {(node as Text).value}
{:else if node.type === "comment" || node.type === "doctype"}
  <!-- 不渲染 -->
{/if}