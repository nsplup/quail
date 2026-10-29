<script module lang="ts">
  /** 模块级实例计数器：contentId 唯一性的兜底（嵌套/兄弟 summary 相同也不撞 id） */
  let nextAccordionUid = 0;
</script>

<script lang="ts">
  /**
   * 折叠面板组件：预览区 HAST <details>/<summary> 的组件化替换
   * （MarkdownNode 的 details 分支分派到本组件，不再渲染原生 details 标签）。
   *
   * 【与全局 store 的分工（需求约定）】
   * - 挂载时折叠状态优先取全局 store（accordionOpen$，见 stores.ts），
   *   无记录再回落 HAST details 的 open 属性（源码 `<details open>`）；
   * - 用户切换折叠 → 本地翻转即时反馈，同时经 setAccordionOpen 上报到
   *   全局 store——预览为虚拟滚动（VList），段滚出视口即卸载、滚回时
   *   重新挂载，store 记录让重挂载恢复用户上次的折叠状态，而非每次
   *   都回落源码 open 属性。
   *
   * 【内容指纹（store 键）】summary 文本哈希（contentHash，复用 worker
   * 的内容指纹实现，纯函数无 DOM 依赖）。选 summary 而非全树的原因：
   * - 块下标 / 子序号随编辑漂移（增量解析），位置键不稳定；
   * - 正文编辑（面板内改字）不改 summary → 折叠状态保留，体验顺滑；
   * - open 属性不参与指纹：折叠状态是视图状态，不属于内容身份。
   *
   * 【嵌套支持】嵌套 <details> 内外层 summary 文本常常相同（默认文案等），
   * 仅用 summary 哈希会让内外层共享同一条 store 记录 → 点击内层改写外层、
   * 重挂载后状态回弹。因此把父面板 key 组合进来形成路径（外层H/内层H），
   * 保证内外层记录独立。父 key 经 MarkdownNode 的 accordionParentKey prop
   * 在 details 子树中向下传递。
   *
   * 【DOM id 唯一性】contentId 用模块级实例计数器兜底，嵌套 / 兄弟面板
   * 即使 key 相同也不会撞 id（aria-controls 始终指向正确元素）。
   *
   * 【HAST 回流语义】node 引用变化（worker 增量重发该段）时：
   * - 指纹不变且 store 有记录（用户交互过）→ 折叠状态以 store 为准，
   *   不随源码 open 属性漂移（store 优先原则的延伸）；
   * - 指纹不变且 store 无记录 → 跟随 HAST open（源码是唯一事实源，
   *   用户未交互过时编辑 `<details open>` 应实时反映到预览）；
   * - 指纹变化（summary 被改写 = 另一个面板）→ 重新走挂载初始化。
   *
   * 【交互】头部为原生 <button>（键盘可达：Tab 聚焦 / 空格或回车切换），
   * aria-expanded / aria-controls 暴露折叠语义；样式见 themes.css
   * （.md-accordion / .md-accordion-summary / .md-accordion-content）。
   */
  import type { Element, ElementContent } from "hast";
  import { untrack } from "svelte";
  import MarkdownNode from "./MarkdownNode.svelte";
  import { getAccordionOpen, setAccordionOpen } from "../stores";
  import { contentHash } from "../worker/contentHash";
  import { t } from "../i18n.svelte";

  let {
    node,
    blockIndex = null,
    parentKey = null,
  }: {
    node: Element;
    blockIndex?: number | null;
    /**
     * 父折叠面板的 key（嵌套时由外层 Accordion 经 MarkdownNode 传入）。
     * 组合进本面板 key，避免内外层 summary 相同 → 共享折叠记录，
     * 导致点击内层时状态错乱 / 重挂载后回弹。
     */
    parentKey?: string | null;
  } = $props();

  /* ---------------- HAST 结构拆分 ---------------- */

  /** summary 子元素（HTML 约定为 details 的首个子元素；容错取第一个） */
  const summaryNode = $derived(
    (node.children ?? []).find(
      (c): c is Element => c.type === "element" && c.tagName === "summary",
    ),
  );
  /** 头部渲染：summary 的子节点；缺失时回落默认文案（同原生浏览器行为） */
  const summaryChildren = $derived(summaryNode?.children ?? []);
  /** 正文渲染：summary 之外的其余子节点 */
  const contentChildren = $derived(
    (node.children ?? []).filter((c) => c !== summaryNode),
  );

  /** HAST open 属性（property-information 规范化后为 boolean；兼容字符串形态） */
  const openFromHast = $derived(isOpen(node));

  /** 面板指纹（store 键）：summary 纯文本哈希（空白折叠归一）；无 summary 时以正文文本兜底 */
  const key = $derived(accordionKey());

  /* ---------------- 折叠状态：store 优先，HAST 兜底 ---------------- */

  /**
   * 当前折叠状态（true = 展开）。求值期同步初始化（不等 $effect）：
   * store 有记录（虚拟滚动重挂载 / 用户交互过）优先，否则回落 HAST open，
   * 首帧即为最终状态，无「先折叠后展开」的闪变。untrack 声明「一次性
   * 读取初值」意图（后续更新统一由下方 $effect 驱动）。
   */
  let open = $state(untrack(() => getAccordionOpen(key) ?? openFromHast));
  /** 已初始化的指纹（变化 = 换了一个面板 → 重新走挂载初始化） */
  let initedKey: string | null = untrack(() => key);

  $effect(() => {
    if (initedKey !== key) {
      /*
       * 指纹变化：换了一个 key。先保存旧 key，再重算——
       * 编辑 summary / 无 summary 时编辑正文 / 嵌套外层漂移都会导致 key 变，
       * 但面板身份未必变（很可能只是改了标题）。此时若新 key 无记录而旧 key
       * 有记录，把旧记录迁移过来，用户折叠意图跟随面板，而非 key 字符串。
       */
      const prevKey = initedKey;
      initedKey = key;
      const stored = getAccordionOpen(key);
      const prev = prevKey !== null ? getAccordionOpen(prevKey) : undefined;
      open = stored ?? prev ?? openFromHast;
      // 迁移：新 key 无记录、旧 key 有记录 → 写入新 key（旧 key 记录保留，无害）
      if (stored === undefined && prev !== undefined) {
        setAccordionOpen(key, prev);
      }
      return;
    }
    /* 同面板 HAST 回流：store 无记录才跟随源码 open 属性 */
    if (getAccordionOpen(key) === undefined) open = openFromHast;
  });

  /** 切换折叠：本地翻转 + 上报全局 store（重挂载时恢复的就是这份状态） */
  function toggle(): void {
    open = !open;
    setAccordionOpen(key, open);
  }

  /* ---------------- 模板辅助 ---------------- */

  /** summary 无子内容时的默认标题（浏览器原生 details 的「Details」行为） */
  const fallbackLabel = $derived(
    summaryChildren.length > 0 ? "" : $t("accordion.details"),
  );

  /**
   * 正文容器 id（aria-controls 关联）：实例级自增，嵌套 / 兄弟面板
   * 即使 key 完全相同也不会撞 id。
   */
  const contentId = `md-acc-${++nextAccordionUid}`;

  /** HAST open 属性读取：boolean true 为常态，兼容 "" / "open" / "true" */
  function isOpen(el: Element): boolean {
    const v = el.properties?.open;
    return v === true || v === "" || v === "open" || v === "true";
  }

  /** 提取 HAST 子树的纯文本（inline 标记展平，空白折叠为单空格） */
  function textOf(n: ElementContent | Element): string {
    if (n.type === "text") return n.value;
    if (n.type === "element") return n.children.map(textOf).join("");
    return "";
  }

  /**
   * 指纹计算（$derived 内调用，依赖 summaryNode / contentChildren / parentKey
   * 自动追踪）：
   * - summary 文本优先，无 summary 时以正文文本兜底（均为空白归一后的哈希）；
   * - 嵌套时组合父 key 形成路径（外层H/内层H），保证内外层记录独立。
   */
  function accordionKey(): string {
    const src = summaryNode
      ? textOf(summaryNode)
      : contentChildren.map(textOf).join("");
    const base = contentHash(src.replace(/\s+/g, " ").trim());
    return parentKey ? `${parentKey}/${base}` : base;
  }
</script>

<!--
  折叠面板：头部 button（键盘可达 + 自带点按切换语义）+ 正文容器。
  结构无关渲染约定与 MarkdownNode 一致：{#each} 锚点为注释（不占宽），
  块体为单一 <MarkdownNode>，格式化工具的换行/空格不产生模板空白节点。

  嵌套：summary 与 content 内的 MarkdownNode 均传入 accordionParentKey={key}，
  内层 details 会组合成 "外层H/内层H" 路径，折叠记录互不干扰。
-->
<div class="md-accordion" class:md-accordion-open={open}>
  <button
    type="button"
    class="md-accordion-summary"
    aria-expanded={open}
    aria-controls={contentId}
    onclick={toggle}
  >
    <svg
      class="md-accordion-chevron"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M4.5 2.5 8 6l-3.5 3.5"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
    {#if summaryChildren.length > 0}
      <span class="md-accordion-label">
        {#each summaryChildren as child, i (`summary-${i}`)}
          <MarkdownNode node={child} {blockIndex} accordionParentKey={key} />
        {/each}
      </span>
    {:else}
      <!-- summary 缺失/为空：默认标题（原生浏览器同样渲染占位文案） -->
      <span class="md-accordion-label">{fallbackLabel}</span>
    {/if}
  </button>
  <div class="md-accordion-content" id={contentId}>
    {#each contentChildren as child, i (`content-${i}`)}
      <!-- 关键：把本面板 key 作为父 key 传下去，内层 Accordion 组合成路径 -->
      <MarkdownNode node={child} {blockIndex} accordionParentKey={key} />
    {/each}
  </div>
</div>
