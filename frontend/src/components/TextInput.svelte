<script lang="ts">
  /**
   * 单行文本输入（contenteditable 实现，替换原生 <input type="text">）。
   *
   * - 核心逻辑在 lib/input/textInput.ts（TextInputController）：选区与
   *   光标监听、剪切/复制/粘贴/全选接口、全局右键菜单注册
   *   （菜单项：剪切、复制、粘贴、分隔线、全选）均在核心层实现；
   * - 本组件只做 Svelte 侧封装：宿主 div 承载原 input 的样式类（聚焦
   *   态改由 focus-within 驱动），内容元素由控制器动态挂入；
   * - value 受控同步：外部值与内容不同才回写（相同跳过，防光标跳动）；
   * - onchange 语义与原生 input 一致：Enter / 失焦提交，值为 trim 后
   *   的结果；oninput 为实时回调（可选）；
   * - 占位符由核心层的 data-empty + data-placeholder 属性渲染
   *   （::before 伪元素），原生 ::placeholder 不可用于 contenteditable。
   */
  import { untrack } from "svelte";
  import { TextInputController } from "../lib/input/textInput";

  let {
    value = "",
    placeholder = "",
    spellcheck = false,
    disabled = false,
    /** 宿主样式类（原 input 的 Tailwind 类，聚焦态用 focus-within:） */
    cls = "h-8 w-full rounded-lg border border-line bg-inset px-2.5 text-xs text-fg outline-none transition-colors placeholder:text-muted focus-within:border-accent",
    /** 内容元素行高：需与宿主内容区高度一致以垂直居中（"normal" 自适应） */
    lineHeight = "30px",
    /** 等宽字体（设置面板字体族名输入等） */
    mono = false,
    ariaLabel = "",
    oninput,
    onchange,
  }: {
    value?: string;
    placeholder?: string;
    spellcheck?: boolean;
    disabled?: boolean;
    cls?: string;
    lineHeight?: string;
    mono?: boolean;
    ariaLabel?: string;
    oninput?: (v: string) => void;
    onchange?: (v: string) => void;
  } = $props();

  let hostEl = $state<HTMLDivElement | null>(null);
  let ctrl: TextInputController | null = null;

  /* 控制器随宿主挂载创建、卸载销毁（一次性；创建时快照当前 props，
     不作为依赖——props 的后续变化由下方同步 effect 处理） */
  $effect(() => {
    const host = hostEl;
    if (!host) return;
    const c = untrack(() =>
      new TextInputController({
        value,
        placeholder,
        spellcheck,
        disabled,
        ariaLabel,
        oninput,
        onchange: (raw) => onchange?.(raw.trim()),
      }),
    );
    host.append(c.el);
    ctrl = c;
    return () => {
      c.destroy();
      ctrl = null;
    };
  });

  /* 外部值 → 内容同步（内容相同则跳过；变更时光标落末尾） */
  $effect(() => {
    const v = value;
    if (ctrl && v !== ctrl.getValue()) ctrl.setValue(v);
  });

  /* 属性直通（占位符 / 禁用态在核心层反映到元素上） */
  $effect(() => {
    const c = ctrl;
    if (!c) return;
    const p = placeholder;
    c.setPlaceholder(p);
    c.setDisabled(disabled);
    c.el.style.lineHeight = lineHeight;
    c.el.style.fontFamily = mono ? "ui-monospace, monospace" : "";
  });

  /* bind:this 句柄：聚焦 / 失焦 / 全选（命令面板打开时聚焦等场景） */
  export function focus(): void {
    ctrl?.focus();
  }

  export function blur(): void {
    ctrl?.el.blur();
  }

  export function selectAll(): void {
    if (!ctrl) return;
    ctrl.focus();
    ctrl.selectAll();
  }
</script>

<div class="ti-host {cls}" bind:this={hostEl} style="min-width: 0;" aria-label={ariaLabel}>
</div>

<style>
  /* 内容元素填满宿主：高度 100% + 行高居中，等价原生 input 的视觉；
     占位符经核心层的 data-empty/data-placeholder 渲染（contenteditable
     不支持原生 ::placeholder） */
  .ti-host :global(.ti-core) {
    width: 100%;
    height: 100%;
    caret-color: currentColor;
  }
  .ti-host :global(.ti-core[data-empty="true"]::before) {
    content: attr(data-placeholder);
    color: var(--ui-muted);
    pointer-events: none;
  }
</style>
