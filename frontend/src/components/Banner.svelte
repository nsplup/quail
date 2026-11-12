<script lang="ts">
  /**
   * 顶部横幅：非模态事件响应浮层（消费 lib/banner.ts）。
   *
   * - 布局：位于大纲、编辑、预览三者上方（正常文档流，挤压三者高度）；
   * - 背景：与大纲、底栏一致（bg-soft）+ 底部分隔线；
   * - 按钮：风格与 confirm 一致（pill + 图标），但无默认聚焦按钮，
   *   也不响应键盘事件（tabindex="-1" 不参与 Tab 焦点序、不绑定任何
   *   keydown；横幅是可忽略的提示，键盘应继续服务编辑区）；
   * - 文案与按钮各占一行：说明文本靠左（过长省略，悬停显示完整路径），
   *   按钮靠右；
   * - 可配置化：说明文本（messageKey/messageParams）与按钮组（buttons，
   *   对齐 Dialog 按钮组口径 value/label/icon，label 为发起方即时翻译）
   *   由发起方注入，组件零业务分支；点击按钮先收起横幅再执行 run；
   * - 「忽略」为横幅固有交互（可忽略提示的保底出口），固定追加于按钮组
   *   末尾：仅收起，不改变任何文档状态（deleted 标记保持，后续保存仍
   *   路由到确认重建流程）。
   */
  import { banner$, type BannerButton } from "../lib/banner";
  import { t } from "../lib/i18n.svelte";
  import Icon from "./Icon.svelte";

  /** 按钮点击：横幅先行收起（confirm 口径：应答即收），再执行注入动作 */
  function click(btn: BannerButton): void {
    banner$.set(null);
    btn.run?.();
  }

  /** 忽略：仅收起横幅，不改变任何文档状态 */
  function ignore(): void {
    banner$.set(null);
  }
</script>

{#if $banner$}
  {@const msg = $t(
    $banner$.messageKey,
    $banner$.messageParams
      ? {
          values: $banner$.messageParams as Record<
            string,
            string | number | boolean
          >,
        }
      : undefined,
  )}
  <div class="banner bg-soft border-b border-line" role="status">
    <!-- 第一行：说明文本（靠左；i18n key + 插值参数由发起方注入） -->
    <p
      class="banner-msg"
      title={typeof $banner$.messageParams?.path === "string"
        ? $banner$.messageParams.path
        : msg}
    >
      {msg}
    </p>
    <!-- 第二行：按钮组（靠右；发起方注入） + 固有忽略按钮 -->
    <div class="banner-actions">
      {#each $banner$.buttons as btn (btn.value)}
        <button class="pill qd-btn" tabindex="-1" onclick={() => click(btn)}>
          {#if btn.icon}
            <Icon name={btn.icon} size={14} />
          {/if}
          <span>{btn.label}</span>
        </button>
      {/each}
      <button class="pill qd-btn" tabindex="-1" onclick={ignore}>
        <Icon name="close" size={14} />
        <span>{$t("banner.ignore")}</span>
      </button>
    </div>
  </div>
{/if}

<style>
  .banner {
    flex: none;
    display: flex;
    flex-direction: column;
    gap: 7px;
    padding: 8px 12px 9px;
  }
  .banner-msg {
    margin: 0;
    font-size: 13px;
    line-height: 1.5;
    color: var(--ui-fg);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .banner-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  /* 与 ConfirmDialog 的 qd-btn 一致：图标 + 文本行内排布 */
  .qd-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
  }
</style>
