<script lang="ts">
  /**
   * 带加减按钮的数字输入组件（设置面板字号等）。
   *
   * - 输入栏为自定义输入框核心（lib/input/textInput.ts，contenteditable
   *   实现）：继承全局右键菜单（剪切/复制/粘贴/全选）与选区监听；
   * - 数字过滤：beforeinput 拦截非数字/小数点字符（与原生 number 输入
   *   的键入过滤同口径）；粘贴/程序化插入的非数字内容在提交时回退；
   * - 提交口径与旧实现一致：Enter / 失焦时 Number(text) → NaN 回退显示
   *   原值，否则 clamp + 0.1 步进取整后经 onchange 提交；
   * - value 受控同步：prop 与内容不同才回写（相同跳过，防光标跳动）。
   */
  import { untrack } from "svelte";
  import { TextInputController } from "../lib/input/textInput";

  let {
    value,
    min = 1,
    max = 100,
    step = 1,
    onchange,
  }: {
    value: number;
    min?: number;
    max?: number;
    step?: number;
    onchange: (v: number) => void;
  } = $props();

  const clamp = (v: number): number => Math.min(max, Math.max(min, v));

  function commit(v: number): void {
    const n = clamp(Math.round(v * 10) / 10);
    if (n !== value) onchange(n);
  }

  function bump(dir: 1 | -1): void {
    commit(clamp((value ?? min) + dir * step));
  }

  let hostEl = $state<HTMLDivElement | null>(null);
  let ctrl: TextInputController | null = null;

  /* 控制器随宿主挂载创建、卸载销毁（创建时快照初值，不作为依赖） */
  $effect(() => {
    const host = hostEl;
    if (!host) return;
    const c = untrack(
      () =>
        new TextInputController({
          value: String(value ?? min),
          ariaLabel: "number",
          onbeforeinput: (ev) => {
            /* 数字过滤：仅放行数字与小数点的键入 */
            if (
              ev.inputType === "insertText" &&
              ev.data &&
              !/[0-9.]/.test(ev.data)
            ) {
              ev.preventDefault();
              return true;
            }
            return false;
          },
          onchange: (raw) => {
            const text = raw.trim();
            const n = Number(text);
            if (!text || !Number.isFinite(n)) {
              c.setValue(String(value));
              return;
            }
            const clamped = clamp(Math.round(n * 10) / 10);
            if (clamped !== value) {
              onchange(clamped);
            } else {
              // 值不变时也必须回写：把越界/未归一化的原始文本恢复为钳制值
              c.setValue(String(clamped));
            }
          },
        }),
    );
    host.append(c.el);
    ctrl = c;
    return () => {
      c.destroy();
      ctrl = null;
    };
  });

  /* 外部值 → 内容同步（内容相同则跳过） */
  $effect(() => {
    const v = String(value);
    if (ctrl && v !== ctrl.getValue()) ctrl.setValue(v);
  });
</script>

<div class="num-in flex items-center rounded-lg border border-line bg-inset">
  <button
    class="flex h-7 w-7 flex-none items-center justify-center text-muted transition-colors hover:text-fg disabled:opacity-40"
    aria-label="decrease"
    disabled={value <= min}
    onclick={() => bump(-1)}
  >
    <svg
      class="h-3.5 w-3.5"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      aria-hidden="true"
    >
      <path d="M3.5 8h9" />
    </svg>
  </button>
  <div
    class="ti-host h-7 w-10 border-x border-line bg-transparent text-center text-xs text-fg outline-none"
    bind:this={hostEl}
  ></div>
  <button
    class="flex h-7 w-7 flex-none items-center justify-center text-muted transition-colors hover:text-fg disabled:opacity-40"
    aria-label="increase"
    disabled={value >= max}
    onclick={() => bump(1)}
  >
    <svg
      class="h-3.5 w-3.5"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      aria-hidden="true"
    >
      <path d="M8 3.5v9M3.5 8h9" />
    </svg>
  </button>
</div>

<style>
  /* 内容元素行高与 28px 内容区对齐（垂直居中，等价原 input 视觉） */
  .ti-host :global(.ti-core) {
    height: 100%;
    line-height: 28px;
    caret-color: currentColor;
  }
</style>
