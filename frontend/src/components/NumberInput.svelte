<script lang="ts">
  /** 带加减按钮的数字输入组件（设置面板字号等） */
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
</script>

<div class="num-in flex items-center rounded-lg border border-line bg-inset">
  <button
    class="flex h-7 w-7 flex-none items-center justify-center text-sm text-muted transition-colors hover:text-fg disabled:opacity-40"
    aria-label="decrease"
    disabled={value <= min}
    onclick={() => bump(-1)}
  >
    −
  </button>
  <input
    class="h-7 w-10 border-x border-line bg-transparent text-center text-xs text-fg outline-none"
    type="number"
    inputmode="decimal"
    {min}
    {max}
    {step}
    {value}
    onchange={(e) => commit(Number((e.target as HTMLInputElement).value))}
  />
  <button
    class="flex h-7 w-7 flex-none items-center justify-center text-sm text-muted transition-colors hover:text-fg disabled:opacity-40"
    aria-label="increase"
    disabled={value >= max}
    onclick={() => bump(1)}
  >
    +
  </button>
</div>

<style>
  .num-in input::-webkit-outer-spin-button,
  .num-in input::-webkit-inner-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }
  .num-in input {
    -moz-appearance: textfield;
    appearance: textfield;
  }
</style>
