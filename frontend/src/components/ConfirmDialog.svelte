<script lang="ts">
  /** 通用确认模态：消费 confirm$（lib/confirm.ts），Promise 化交互。
   *
   * - dirty 模式：保存（软盘）/ 丢弃（垃圾桶）/ 取消（叉）三按钮；
   * - confirm 模式：确定 / 取消（叉）；
   * - deletedSave 模式：仍然保存（软盘）/ 取消（叉）。
   * - Tab / Shift+Tab 在可用按钮间循环切换 active 样式；
   *   Enter 触发当前 active 按钮；Esc 取消（安全侧默认）。
   *   初始 active 置于「取消」按钮。
   *   键盘监听走 window 捕获阶段并阻断传播：弹窗期间 CM6 即使持有焦点，
   *   Enter / Tab 也不会进入编辑器 keymap。 */
  import { untrack } from "svelte";
  import { get } from "svelte/store";
  import {
    confirm$,
    dialogMask$ as dialogMaskStore,
    type ConfirmResult,
  } from "../lib/confirm";
  import { t } from "../lib/i18n.svelte";
  import Icon from "./Icon.svelte";

  type Btn = {
    value: ConfirmResult;
    label: string;
    icon?: "floppy" | "trash" | "close";
  };

  // 仅事件处理内部使用，不需要响应式
  let pressedOnOverlay = false;

  let activeIdx = $state(0);

  // store 自动订阅在 runes 模式下仍受支持，$derived 会追踪其变化
  let cur = $derived($confirm$);
  let dialogMask = $derived($dialogMaskStore);

  /** 面板根元素：出现时把焦点交给面板本身（tabindex="-1" 仅允许程序化聚焦，
   *  不给按钮；键盘交互由 window 捕获监听统一处理，面板持有焦点不影响） */
  let boxEl = $state<HTMLDivElement | null>(null);

  // confirm 面板出现时自动获得焦点（焦点给面板而非按钮）
  $effect(() => {
    if (cur) boxEl?.click();
  });

  let buttons = $derived.by((): Btn[] => {
    const c = cur;
    if (!c) return [];
    const cancelBtn: Btn = {
      value: "cancel",
      label: $t("common.cancel"),
      icon: "close",
    };
    if (c.mode === "dirty") {
      return [
        { value: "save", label: $t("confirm.save"), icon: "floppy" },
        { value: "discard", label: $t("confirm.discard"), icon: "trash" },
        cancelBtn,
      ];
    }
    if (c.mode === "deletedSave") {
      return [
        { value: "save", label: $t("confirm.saveStill"), icon: "floppy" },
        cancelBtn,
      ];
    }
    return [{ value: "ok", label: $t("confirm.ok") }, cancelBtn];
  });

  // 普通 let：只需在 $effect 内保存上一模式，无需响应式
  let prevMode: string | undefined;

  // 打开 / 模式切换时，active 默认落在「取消」上（安全侧默认）
  $effect(() => {
    if (!cur) {
      prevMode = undefined;
      return;
    }
    if (prevMode !== cur.mode) {
      prevMode = cur.mode;
      // untrack：只追踪 cur，避免 $t 变化导致 buttons 重算时重复执行
      activeIdx = untrack(() => buttons.length) - 1;
    }
  });

  function answer(v: ConfirmResult): void {
    const c = get(confirm$);
    if (!c) return;
    c.resolve(v);
    confirm$.set(null);
  }

  function onKeydown(e: KeyboardEvent): void {
    if (!cur) return;

    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      answer("cancel");
      return;
    }

    if (e.key === "Tab") {
      // 捕获阶段拦截并阻断传播：避免焦点移出弹窗或被编辑器 keymap 处理
      e.preventDefault();
      e.stopPropagation();
      if (buttons.length === 0) return;
      const dir = e.shiftKey ? -1 : 1;
      activeIdx = (activeIdx + dir + buttons.length) % buttons.length;
      return;
    }

    if (e.key === "Enter") {
      // 触发当前 active 按钮；默认 active 为取消，防止回车误触不可逆操作
      e.preventDefault();
      e.stopPropagation();
      const btn = buttons[activeIdx];
      if (btn) answer(btn.value);
    }
  }
</script>

<svelte:window onkeydowncapture={onKeydown} />

{#if dialogMask}
  <!-- 系统弹窗专用空白 confirm：只有遮罩没有面板。不绑定任何点击处理
       （无法通过点击关闭），仅在系统弹窗得到结果后由 withDialogMask
       关闭；期间阻断对界面的进一步交互。 -->
  <div class="fixed inset-0 z-[70] bg-black/45" aria-hidden="true"></div>
{/if}

{#if cur}
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
    <div
      class="qd-box w-full max-w-sm rounded-xl border p-4 shadow-2xl"
      tabindex="-1"
      bind:this={boxEl}
    >
      <p class="qd-msg mb-4 whitespace-pre-line text-sm leading-relaxed">
        {cur.msg}
      </p>
      <div class="flex justify-end gap-2">
        {#each buttons as btn, i (btn.value)}
          <button
            class="pill qd-btn"
            class:active={activeIdx === i}
            onclick={() => answer(btn.value)}
          >
            {#if btn.icon}
              <Icon name={btn.icon} size={14} />
            {/if}
            <span>{btn.label}</span>
          </button>
        {/each}
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
</style>
