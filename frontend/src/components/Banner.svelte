<script lang="ts">
  /**
   * 顶部横幅：外部修改 / 外部删除事件的非模态响应（消费 lib/banner.ts）。
   *
   * - 布局：位于大纲、编辑、预览三者上方（正常文档流，挤压三者高度）；
   * - 背景：与大纲、底栏一致（bg-soft）+ 底部分隔线；
   * - 按钮：风格与 confirm 一致（pill + 图标），但无默认聚焦按钮，
   *   也不响应键盘事件（tabindex="-1" 不参与 Tab 焦点序、不绑定任何
   *   keydown；横幅是可忽略的提示，键盘应继续服务编辑区）；
   * - 文案与按钮各占一行：说明文本靠左（过长省略，悬停显示完整路径），
   *   按钮靠右。
   */
  import { banner$ as banner } from "../lib/banner";
  import { t } from "../lib/i18n.svelte";
  import Icon from "./Icon.svelte";

  /** 主操作（重新加载 / 另存为）：横幅先行收起（confirm 口径：应答即收），
   * 动作由发起方注入的回调执行 */
  function primary(): void {
    const cur = $banner;
    if (!cur) return;
    banner.set(null);
    cur.onPrimary();
  }

  /** 忽略：仅收起横幅，不改变任何文档状态（deleted 标记保持，
   * 后续保存仍路由到确认重建流程） */
  function ignore(): void {
    banner.set(null);
  }
</script>

{#if $banner}
  <div class="banner bg-soft border-b border-line" role="status">
    <!-- 第一行：说明文本（靠左） -->
    <p class="banner-msg" title={$banner.path}>
      {$t(`banner.${$banner.kind}`, { values: { path: $banner.path } })}
    </p>
    <!-- 第二行：按钮（靠右） -->
    <div class="banner-actions">
      {#if $banner.kind === "modified"}
        <!-- 重新加载：丢弃本地状态，从磁盘重读装载 -->
        <button class="pill qd-btn" tabindex="-1" onclick={primary}>
          <Icon name="refresh" size={14} />
          <span>{$t("banner.reload")}</span>
        </button>
      {:else}
        <!-- 另存为：把当前内容落到新路径，解除删除标记 -->
        <button class="pill qd-btn" tabindex="-1" onclick={primary}>
          <Icon name="floppy" size={14} />
          <span>{$t("common.saveAs")}</span>
        </button>
      {/if}
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
