<script lang="ts">
  /** 单行文本输入（设置面板字体配置等），风格与面板内其他输入一致 */
  let {
    value = "",
    placeholder = "",
    spellcheck = false,
    onchange,
  }: {
    value?: string;
    placeholder?: string;
    spellcheck?: boolean;
    onchange: (v: string) => void;
  } = $props();
</script>

<input
  class="h-8 w-full rounded-lg border border-line bg-inset px-2.5 text-xs text-fg outline-none transition-colors placeholder:text-muted focus:border-accent"
  style:font-family="ui-monospace, monospace"
  type="text"
  {value}
  {placeholder}
  {spellcheck}
  onchange={(e) => onchange((e.target as HTMLInputElement).value.trim())}
/>
