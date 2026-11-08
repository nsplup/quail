<script lang="ts">
  /**
   * 通用遮罩（弹层基座）：fixed 全屏半透明遮罩 + 居中内容容器。
   *
   * 设置面板（SettingsModal）与 confirm 弹窗（ConfirmDialog）共用此基座，
   * 消除两处手写遮罩 div 与重复的「遮罩点击关闭」逻辑。
   *
   * - z-index：必传 prop（内联 style 注入 —— Tailwind 任意值类名无法动态
   *   拼接）。约定：confirm（70）必须高于 settings（50），保证叠加时
   *   confirm 在最上层；
   * - 遮罩点击关闭：onOverlayClick 回调 + pointerdown/pointerup 双判定
   *   （按下与抬起都在遮罩自身上才算点击，避免拖拽误关），面板用
   *   closeSettings / answer("cancel") 接入；
   * - 【状态暴露】自身开合状态同步到全局 STORE（stores.ts 的
   *   overlayRegistry$）：组件挂载即「遮罩开启」（注册 symbol 实例），
   *   卸载即「关闭」（注销）。原先判断遮罩是否开启的条件分支
   *   （App 全局快捷键守卫 / file:dropped 守卫 / CM6 editable 同步）
   *   一律消费派生的 overlayOpen$，不再组合 settingsOpen$ / confirm$。
   *   注意：组件仅在面板开启时被 {#if} 挂载，因此「挂载 = 开启」成立；
   * - 布局：统一为 grid place-items-center 居中（与原 settings 遮罩一致；
   *   原 confirm 的 flex 居中语义相同），容器附加类经 class prop 透传
   *   （如 confirm 的 p-4）。
   */
  import type { Snippet } from "svelte";
  import { overlayRegistry$ } from "../lib/overlay";

  let {
    zIndex = 50,
    onOverlayClick,
    role = "presentation",
    ariaModal = false,
    ariaLabel,
    tabindex,
    class: extraClass = "",
    children,
  }: {
    /** 遮罩层级（内联 style 注入）：confirm=70 > settings=50 */
    zIndex?: number;
    /** 遮罩点击（pointerdown+pointerup 均落在遮罩自身）时回调 */
    onOverlayClick?: () => void;
    role?: "dialog" | "presentation";
    ariaModal?: boolean;
    ariaLabel?: string;
    /** -1 时遮罩可编程聚焦（settings 面板用于 focus-trap 激活聚焦） */
    tabindex?: number;
    /** 透传到遮罩容器的附加类（如 p-4） */
    class?: string;
    children: Snippet;
  } = $props();

  // 仅事件处理内部使用，不需要响应式
  let pressedOnOverlay = false;

  /* 自身状态 → 全局 STORE：挂载即开启、卸载即关闭（$effect cleanup 保证
     与组件生命周期严格同步，虚拟滚动 / 条件渲染下无泄漏）。symbol 隔离
     多实例（未来叠加遮罩时 size 语义依旧正确）。 */
  const overlayKey = Symbol("overlay");
  $effect(() => {
    overlayRegistry$.update((s) => new Set(s).add(overlayKey));
    return () => {
      overlayRegistry$.update((s) => {
        const next = new Set(s);
        next.delete(overlayKey);
        return next;
      });
    };
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  class="fixed inset-0 grid place-items-center bg-black/45 {extraClass}"
  style="z-index: {zIndex};"
  {role}
  aria-modal={ariaModal || undefined}
  aria-label={ariaLabel}
  tabindex={tabindex}
  onpointerdown={(e) => {
    pressedOnOverlay = e.target === e.currentTarget;
  }}
  onpointerup={(e) => {
    if (
      onOverlayClick &&
      pressedOnOverlay &&
      e.target === e.currentTarget
    ) {
      onOverlayClick();
    }
    pressedOnOverlay = false;
  }}
>
  {@render children()}
</div>
