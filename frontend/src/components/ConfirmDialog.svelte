<script lang="ts">
  /** 通用确认模态：消费 confirm$（lib/confirm.ts），Promise 化交互 */
  import { get } from "svelte/store";
  import { confirm$ } from "../lib/confirm";
  import { t } from "../lib/i18n.svelte";

  function answer(v: boolean): void {
    const cur = get(confirm$);
    cur?.resolve(v);
    confirm$.set(null);
  }

  function onKeydown(e: KeyboardEvent): void {
    if (!get(confirm$)) return;
    if (e.key === "Escape") answer(false);
    if (e.key === "Enter") answer(true);
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if $confirm$}
  {@const cur = $confirm$}
  <div
    class="fixed inset-0 z-[70] flex items-center justify-center bg-black/45 p-4"
    role="presentation"
    onkeydown={onKeydown}
    onclick={(e) => {
      if (e.target === e.currentTarget) answer(false);
    }}
  >
    <div class="qd-box w-full max-w-sm rounded-xl border p-4 shadow-2xl">
      <p class="mb-4 text-sm leading-relaxed qd-msg">{cur.msg}</p>
      <div class="flex justify-end gap-2">
        <button class="pill" onclick={() => answer(false)}>{$t("common.close")}</button>
        <button class="pill qd-ok" onclick={() => answer(true)}>{$t("confirm.ok")}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .qd-box {
    background: var(--ui-bg);
    border-color: var(--ui-border);
  }
  .qd-msg {
    color: var(--ui-fg);
  }
  .qd-ok {
    color: var(--ui-accent);
    border-color: var(--ui-accent);
  }
  .qd-ok:hover {
    background: var(--ui-active-bg);
  }
</style>
