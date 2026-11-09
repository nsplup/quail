<script lang="ts">
  /**
   * 通用对话框（Dialog.svelte）：消费 lib/dialog.ts 的 confirm$ / progress$，
   * 渲染两种面板——
   *
   * - confirm 面板（zIndex 70）：可配置按钮（DialogButton[]，默认确定 /
   *   取消）。焦点管理交给 focus-trap（lib/focusTrap.ts 的 attachment
   *   包装）：Tab / Shift+Tab 在面板内循环移动焦点，按钮使用浏览器默认
   *   focus outline；Enter 触发当前聚焦按钮；Esc 经 focus-trap 的
   *   escapeDeactivates 触发 onDeactivate → answer(dismissValue)（安全侧
   *   默认）；遮罩点击（pointerdown/pointerup 双判定在 Overlay 内）同样
   *   answer(dismissValue)。打开面板时自动聚焦面板内最后一个可聚焦按钮
   *   （习惯上取消位于最右）。
   * - progress 面板（zIndex 75，可与 confirm 叠加且在最上层）：长耗时任务
   *   状态框，遮罩【无法被交互关闭】——无遮罩点击回调、focus-trap
   *   escapeDeactivates: false（Esc 不触发关闭）；只能由业务方
   *   handle.finish() 关闭（结束前至少停留 minDurationMs）或用户点击
   *   配置的按钮（默认无按钮）。无按钮时焦点落在面板容器（tabindex=-1）
   *   并由 fallbackFocus 兜底。
   *
   * 开合状态经 Overlay 的 overlayRegistry$ 全局暴露（口径与设置面板 /
   * 旧 ConfirmDialog 一致，快捷键守卫与 CM6 editable 同步照常生效）。
   */
  import { get } from "svelte/store";
  import { confirm$, progress$, type ConfirmState } from "../lib/dialog";
  import { focusTrap } from "../lib/focusTrap";
  import Icon from "./Icon.svelte";
  import Overlay from "./Overlay.svelte";

  let curConfirm = $derived($confirm$);
  let curProgress = $derived($progress$);

  function answerConfirm(c: ConfirmState, value: string): void {
    confirm$.set(null); // 先置空再 resolve：answer 为幂等空操作（见旧实现注释）
    c.resolve(value);
  }

  /* confirm 面板焦点圈定：Esc → dismissValue（安全侧），遮罩点击同口径。
   * 打开时聚焦最后一个按钮（取消习惯上位于最右）；不再归还焦点以避免
   * 焦点被重置到编辑器顶部引发预期外的滚动同步。 */
  const confirmTrap = focusTrap({
    allowOutsideClick: true,
    initialFocus: ".qd-btn:last-of-type",
    onDeactivate: () => {
      const c = get(confirm$);
      if (c) answerConfirm(c, c.dismissValue);
    },
    returnFocusOnDeactivate: false,
  });

  /* progress 面板焦点圈定：Esc 不触发关闭（escapeDeactivates: false），
   * 无遮罩点击回调 → 面板只能经 handle.finish() 或按钮回调关闭。 */
  const progressTrap = focusTrap({
    allowOutsideClick: true,
    escapeDeactivates: false,
    initialFocus: ".qprog-box",
    fallbackFocus: ".qprog-box",
    returnFocusOnDeactivate: false,
  });
</script>

{#if curConfirm}
  <Overlay zIndex={70} class="p-4" onOverlayClick={() => answerConfirm(curConfirm, curConfirm.dismissValue)}>
    <div
      class="qd-box w-full max-w-sm rounded-xl border p-4 shadow-2xl"
      {@attach confirmTrap}
    >
      <p class="qd-msg mb-4 whitespace-pre-line text-sm leading-relaxed">
        {curConfirm.msg}
      </p>
      <div class="flex justify-end gap-2">
        {#each curConfirm.buttons as btn (btn.value)}
          <button
            class="pill qd-btn"
            onclick={() => answerConfirm(curConfirm, btn.value)}
          >
            {#if btn.icon}
              <Icon name={btn.icon} size={14} />
            {/if}
            <span>{btn.label}</span>
          </button>
        {/each}
      </div>
    </div>
  </Overlay>
{/if}

{#if curProgress}
  <Overlay zIndex={75} class="p-4" ariaLabel={curProgress.msg}>
    <div
      class="qprog-box w-full max-w-sm rounded-xl border p-4 shadow-2xl"
      tabindex="-1"
      {@attach progressTrap}
    >
      <div class="flex items-center gap-3">
        <div class="qprog-spinner" aria-hidden="true"></div>
        <p class="qd-msg whitespace-pre-line text-sm leading-relaxed">
          {curProgress.msg}
        </p>
      </div>
      {#if curProgress.buttons.length > 0}
        <div class="mt-4 flex justify-end gap-2">
          {#each curProgress.buttons as btn (btn.value)}
            <button
              class="pill qd-btn"
              onclick={() => curProgress.resolve(btn.value)}
            >
              {#if btn.icon}
                <Icon name={btn.icon} size={14} />
              {/if}
              <span>{btn.label}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </Overlay>
{/if}

<style>
  .qd-box,
  .qprog-box {
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
  /* 进度旋转指示：细描边圆环匀速旋转（与 Toast/ParseStatus 的静态风格区分） */
  .qprog-spinner {
    flex: none;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    border: 2px solid var(--ui-border);
    border-top-color: var(--ui-fg);
    animation: qprog-spin 0.9s linear infinite;
  }
  @keyframes qprog-spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
