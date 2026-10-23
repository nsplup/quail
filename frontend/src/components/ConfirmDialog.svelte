<script lang="ts">
  /** 通用确认模态：消费 confirm$（lib/confirm.ts），Promise 化交互。
   *
   * - dirty 模式：保存（软盘）/ 丢弃（垃圾桶）/ 取消（叉）三按钮；
   * - confirm 模式：确定 / 取消（叉）；
   * - deletedSave 模式：仍然保存（软盘）/ 取消（叉）。
   * - 焦点管理交给 focus-trap（lib/focusTrap.ts 的 attachment 包装）：
   *   Tab / Shift+Tab 由 focus-trap 在面板内循环移动焦点，按钮使用浏览器
   *   默认 focus outline（不再有 active class 高亮，也不劫持按键）。
   *   Enter 触发当前聚焦按钮；Esc 经 focus-trap 的 escapeDeactivates 触发
   *   onDeactivate → answer("cancel")（安全侧默认）。
   *   打开面板时 focus-trap 自动聚焦面板内第一个可聚焦按钮。
   * - 系统弹窗专用空白遮罩（dialogMask$）：只有遮罩没有面板。内部放置一个
   *   占位元素（无面板时容器内没有任何可聚焦节点，focus-trap 无法激活），
   *   同样建立 trap，阻断遮罩期间的焦点逃逸。 */
  import { get } from "svelte/store";
  import {
    confirm$,
    dialogMask$ as dialogMaskStore,
    type ConfirmResult,
  } from "../lib/confirm";
  import { focusTrap } from "../lib/focusTrap";
  import { t } from "../lib/i18n.svelte";
  import Icon from "./Icon.svelte";

  type Btn = {
    value: ConfirmResult;
    label: string;
    icon?: "floppy" | "trash" | "close";
  };

  // 仅事件处理内部使用，不需要响应式
  let pressedOnOverlay = false;

  // store 自动订阅在 runes 模式下仍受支持，$derived 会追踪其变化
  let cur = $derived($confirm$);
  let dialogMask = $derived($dialogMaskStore);

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

  function answer(v: ConfirmResult): void {
    const c = get(confirm$);
    if (!c) return;
    c.resolve(v);
    confirm$.set(null);
  }

  /** confirm 面板的 trap：
   * - allowOutsideClick：放行遮罩上的点击（点击关闭由 overlay 的
   *   pointerdown/pointerup 处理，不经 focus-trap）；
   * - initialFocus：初始焦点置于「取消」按钮（按钮序列最后一个），保留
   *   原实现的「安全侧默认」—— 回车不会误触保存/确定，Esc 同样取消；
   * - onDeactivate：Esc（escapeDeactivates 默认开启）触发取消。注意经
   *   answer 关闭面板时 confirm$ 已置空，此处的 answer("cancel") 为幂等
   *   空操作，不会重复 resolve。 */
  const dialogTrap = focusTrap({
    allowOutsideClick: true,
    initialFocus: ".qd-btn:last-of-type",
    onDeactivate: () => answer("cancel"),
  });

  /** 系统弹窗空白遮罩的 trap：
   * - 容器内没有任何可聚焦节点，靠占位元素 + fallbackFocus 兜底激活；
   * - escapeDeactivates 关闭：Esc 属于系统弹窗自身，遮罩保持到
   *   withDialogMask 结束（元素卸载时由 attachment 清理函数 deactivate）。 */
  const maskTrap = focusTrap({
    allowOutsideClick: true,
    escapeDeactivates: false,
    fallbackFocus: "[data-mask-placeholder]",
  });
</script>

{#if dialogMask}
  <!-- 系统弹窗专用空白 confirm：只有遮罩没有面板。不绑定任何点击处理
       （无法通过点击关闭），仅在系统弹窗得到结果后由 withDialogMask
       关闭；期间阻断对界面的进一步交互。 -->
  <div
    class="fixed inset-0 z-[70] bg-black/45"
    role="presentation"
    {@attach maskTrap}
  >
    <!-- 占位元素：纯遮罩容器内没有任何可聚焦节点，focus-trap 激活时
         会因找不到可聚焦目标而失败；该占位节点不可 Tab 进入
         （tabindex="-1"），仅作为 fallbackFocus 的落点。 -->
    <div class="mask-placeholder" tabindex="-1" data-mask-placeholder></div>
  </div>
{/if}

{#if cur}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
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
      {@attach dialogTrap}
    >
      <p class="qd-msg mb-4 whitespace-pre-line text-sm leading-relaxed">
        {cur.msg}
      </p>
      <div class="flex justify-end gap-2">
        {#each buttons as btn (btn.value)}
          <button
            class="pill qd-btn"
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
  .mask-placeholder {
    outline: none !important;
  }
</style>
