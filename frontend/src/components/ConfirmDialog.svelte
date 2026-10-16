<script lang="ts">
  /** 通用确认模态：消费 confirm$（lib/confirm.ts），Promise 化交互。
   *
   * - dirty 模式：保存（软盘）/ 丢弃（垃圾桶）/ 取消（叉）三按钮；
   * - confirm 模式：确定 / 取消（叉）；
   * - deletedSave 模式：仍然保存（软盘）/ 取消（叉）。
   * - 回车与 Esc 均映射为「取消」（安全侧默认），强调色置于取消按钮；
   *   键盘监听走 window 捕获阶段并阻断传播：弹窗期间 CM6 即使持有焦点，
   *   Enter 也不会进入编辑器 keymap（否则会先插入换行）。 */
  import { get } from "svelte/store";
  import { confirm$, type ConfirmResult } from "../lib/confirm";
  import { t } from "../lib/i18n.svelte";
  import Icon from "./Icon.svelte";

  let pressedOnOverlay = false;

  function answer(v: ConfirmResult): void {
    const cur = get(confirm$);
    cur?.resolve(v);
    confirm$.set(null);
  }

  function onKeydown(e: KeyboardEvent): void {
    if (!get(confirm$)) return;
    // 回车默认取消而非确认：防止回车误触丢弃/覆盖等不可逆操作
    if (e.key === "Escape" || e.key === "Enter") {
      // 捕获阶段拦截（window 最先收到）并阻断传播：若放行，CM6 编辑器
      // 持有焦点时其 keymap 会在编辑器 DOM 层先处理 Enter 插入换行
      e.preventDefault();
      e.stopPropagation();
      answer("cancel");
    }
  }
</script>

<svelte:window onkeydowncapture={onKeydown} />

{#if $confirm$}
  {@const cur = $confirm$}
  <div
    class="fixed inset-0 z-[70] flex items-center justify-center bg-black/45 p-4"
    role="presentation"
    onpointerdown={(e) => {
      pressedOnOverlay = e.target === e.currentTarget;
    }}
    onpointerup={(e) => {
      if (pressedOnOverlay && e.target === e.currentTarget) answer("cancel");
      pressedOnOverlay = false;
    }}
  >
    <div class="qd-box w-full max-w-sm rounded-xl border p-4 shadow-2xl">
      <p class="qd-msg mb-4 whitespace-pre-line text-sm leading-relaxed">
        {cur.msg}
      </p>
      <div class="flex justify-end gap-2">
        {#if cur.mode === "dirty"}
          <!-- 保存：先落盘当前文档，再继续被拦截的操作 -->
          <button class="pill qd-btn" onclick={() => answer("save")}>
            <Icon name="floppy" size={14} />
            <span>{$t("confirm.save")}</span>
          </button>
          <!-- 丢弃：放弃未保存修改，直接继续被拦截的操作 -->
          <button class="pill qd-btn" onclick={() => answer("discard")}>
            <Icon name="trash" size={14} />
            <span>{$t("confirm.discard")}</span>
          </button>
        {:else if cur.mode === "deletedSave"}
          <!-- 仍然保存：确认后覆盖重建已被外部删除的原文件 -->
          <button class="pill qd-btn" onclick={() => answer("save")}>
            <Icon name="floppy" size={14} />
            <span>{$t("confirm.saveStill")}</span>
          </button>
        {:else}
          <button class="pill" onclick={() => answer("ok")}
            >{$t("confirm.ok")}</button
          >
        {/if}
        <!-- 取消：默认按钮（强调色），中止被拦截的操作 -->
        <button class="pill qd-btn qd-primary" onclick={() => answer("cancel")}>
          <Icon name="close" size={14} />
          <span>{$t("common.cancel")}</span>
        </button>
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
  .qd-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
  }
  .qd-primary {
    color: var(--ui-accent);
    border-color: var(--ui-accent);
  }
  .qd-primary:hover {
    background: var(--ui-active-bg);
  }
</style>
