<script lang="ts">
  /**
   * 可编辑复选框组件：预览区 GFM 任务列表项（`- [ ]` / `- [x]`）的原地
   * 勾选状态切换渲染（参考 EditableTable 的「显示来自 worker HAST + 反向
   * 更新编辑区源码」闭环）。
   *
   * 【与增量解析 worker 的分工】
   * - 勾选状态完全来自 worker 产出的 HAST（input 的 checked 属性），组件
   *   不重复解析；点击后先本地翻转即时反馈，再经 EditorApi.replaceLines
   *   反向更新编辑区对应源码行 → doc$ 变化 → worker 重解析 → HAST 回流
   *   后本地状态被权威结果覆盖（回流前/失败时本地翻转自动回落）。
   *
   * 【源码定位】复选框所在预览块的行界（blocks$[blockIndex]）为种子区间，
   * 区间内任务标记行与渲染出的 task-list-item 在文档顺序上一一对应，组件
   * 以「同块内渲染序号」对位到具体源码行（见 task-source.ts）。定位失败
   * （区块漂移 / raw HTML 任务项等）→ 静态渲染（不可交互）。
   *
   * 【交互】<label> 包裹原生 input（视觉隐藏、保留语义与键盘可用：Tab
   * 聚焦 / 空格切换）+ 自绘勾选框；label 扩大点击热区并自带「点按即切换」
   * 语义。样式见 themes.css（.md-task-check / .md-task-box）。
   */
  import type { Element } from "hast";
  import { get } from "svelte/store";
  import { editorApi$, blocks$ } from "../stores";
  import { findTaskMarkerLines, flipTaskMarker } from "./task-source";
  import { t } from "../i18n.svelte";
  import { untrack } from "svelte";

  let { node, blockIndex = null }: { node: Element; blockIndex?: number | null } = $props();

  /* worker HAST 的勾选状态（sanitize 后 checked 为 boolean） */
  const checkedFromProps = $derived(node.properties?.checked === true);

  /** 本地即时翻转（null = 跟随 props；回流/失败后回落权威状态） */
  let localChecked = $state<boolean | null>(null);
  let lastNode = untrack(() => node);
  $effect(() => {
    // worker 回流（节点引用变化）→ 丢弃本地翻转，跟随权威状态
    if (node !== lastNode) {
      lastNode = node;
      localChecked = null;
    }
  });

  const shown = $derived(localChecked ?? checkedFromProps);
  /** 静态模式：源码定位不可用（无 blockIndex / 无编辑器实例） */
  const isStatic = $derived(blockIndex == null);

  let boxEl: HTMLLabelElement | undefined = $state();

  /**
   * 反向更新：把同块内第 ordinal 个任务标记行的勾选字符翻转后
   * 经 replaceLines 写回编辑区（光标锚定到标记字符，与表格回写同口径）。
   * 返回 false 表示定位失败（调用方回落静态渲染）。
   */
  function writeBack(inputEl: HTMLInputElement): boolean {
    const api = get(editorApi$);
    const idx = blockIndex;
    if (!api || idx == null) return false;
    const block = get(blocks$)[idx];
    if (!block) return false;

    // 渲染序号：同块内本复选框的文档顺序（组件渲染产物与 HAST 同序）
    const scope = boxEl?.closest(".md-block");
    if (!scope) return false;
    const all = scope.querySelectorAll('.md-task-check input[type="checkbox"]');
    const ordinal = Array.prototype.indexOf.call(all, inputEl);
    if (ordinal < 0) return false;

    const doc = api.getDoc();
    const tasks = findTaskMarkerLines(doc, block.startLine, block.endLine);
    if (ordinal >= tasks.length) return false;
    const info = tasks[ordinal];
    const lines = doc.split("\n");
    const flipped = flipTaskMarker(lines[info.line - 1]);
    if (flipped == null) return false;
    // replaceLines 行号 1-based；光标落在勾选标记字符上
    api.replaceLines(info.line, info.line, flipped, info.bracketOffset + 1);
    return true;
  }

  function onToggle(ev: Event): void {
    const input = ev.currentTarget as HTMLInputElement;
    // 立即本地反馈；定位失败回滚（等 worker 权威状态回流覆盖）
    const next = input.checked;
    localChecked = next;
    if (!writeBack(input)) localChecked = null;
  }
</script>

<!-- label 内嵌 input：隐式关联，点按 label 任意处（含自绘框）即切换 -->
<label
  class="md-task-check"
  class:md-task-checked={shown}
  class:md-task-static={isStatic}
  bind:this={boxEl}
>
  <input
    type="checkbox"
    checked={shown}
    disabled={isStatic}
    aria-label={$t("task.toggle")}
    onchange={onToggle}
  />
  <span class="md-task-box" aria-hidden="true">
    <svg viewBox="0 0 12 12" fill="none">
      <path d="M2.5 6.2 5 8.7 9.5 3.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  </span>
</label>
