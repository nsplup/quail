<script lang="ts">
  /**
   * 命令面板（CommandPalette）：Ctrl+Shift+P 调出（App.svelte 单独监听
   * toggle——面板开关不进 GLOBAL_SHORTCUTS）。
   *
   * - 命令来源：GLOBAL_SHORTCUTS 转换（buildCommands，action 去重 +
   *   快捷键合并展示）+ 面板专属命令（归档图片，无快捷键）；
   * - 交互：关键词过滤（标题 + 命令 id，大小写不敏感）、↑/↓ 高亮、
   *   Enter 执行、Esc / 遮罩点击关闭、鼠标 hover 即高亮；快捷键以
   *   风格化 kbd 徽标显示在命令右侧（无快捷键命令不显示）；
   * - 执行序：先关闭面板再执行命令（归档命令会弹保存对话框 /
   *   progress，避免与面板遮罩叠加）；
   * - 开合状态经 Overlay 基座注册进 overlayRegistry$（与设置面板 /
   *   confirm 弹窗同口径：开启期间全局快捷键整链短路）。
   */
  import { t } from "../lib/i18n.svelte";
  import {
    commandPaletteOpen$,
    closeCommandPalette,
    buildCommands,
    type CommandItem,
  } from "../lib/commandPalette";
  import type { ShortcutActions } from "../lib/shortcuts";
  import Overlay from "./Overlay.svelte";

  let { actions }: { actions: ShortcutActions } = $props();

  let query = $state("");
  let active = $state(0);
  let inputEl: HTMLInputElement | undefined = $state();
  let listEl: HTMLUListElement | undefined = $state();

  const commands = $derived(buildCommands());
  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(
      (c) => c.id.includes(q) || $t(c.titleKey).toLowerCase().includes(q)
    );
  });

  /* 打开：清空过滤词、高亮复位、聚焦输入框（组件仅在开启时挂载内容） */
  $effect(() => {
    if ($commandPaletteOpen$) {
      query = "";
      active = 0;
      inputEl?.focus();
    }
  });

  /* 过滤词变化（含打开时清空）→ 高亮复位 */
  $effect(() => {
    query;
    active = 0;
  });

  /* 高亮项滚入可视区（键盘导航 / hover 同步） */
  $effect(() => {
    if (!$commandPaletteOpen$) return;
    listEl
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" });
  });

  /** 执行命令：先关闭面板再 run（命令可能再弹对话框 / progress） */
  function runItem(item: CommandItem): void {
    closeCommandPalette();
    item.run(actions);
  }

  /* 面板容器统一键盘处理：输入框与命令按钮的按键都冒泡到这里 */
  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      closeCommandPalette();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      active = Math.min(active + 1, filtered.length - 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      active = Math.max(active - 1, 0);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = filtered[active];
      if (item) runItem(item);
    }
  }
</script>

{#if $commandPaletteOpen$}
  <Overlay
    zIndex={60}
    class="p-4"
    role="dialog"
    ariaModal={true}
    ariaLabel={$t("palette.title")}
    onOverlayClick={closeCommandPalette}
  >
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="flex w-[440px] max-w-[calc(100vw-48px)] flex-col overflow-hidden rounded-xl border border-line bg-app shadow-2xl"
      onkeydown={onKeydown}
    >
      <input
        bind:this={inputEl}
        bind:value={query}
        class="w-full border-b border-line bg-transparent px-3.5 py-2.5 text-sm outline-none placeholder:text-muted"
        placeholder={$t("palette.placeholder")}
        aria-label={$t("palette.placeholder")}
      />
      <ul
        bind:this={listEl}
        class="max-h-[320px] overflow-y-auto py-1"
      >
        {#each filtered as item, i (item.id)}
          <li>
            <button
              type="button"
              class="qcmd-item flex w-full items-center justify-between gap-4 px-3.5 py-2 text-left text-sm"
              class:qcmd-active={i === active}
              data-active={i === active}
              onpointerenter={() => (active = i)}
              onclick={() => runItem(item)}
            >
              <span class="truncate">{$t(item.titleKey)}</span>
              {#if item.shortcut}
                <kbd class="qcmd-key">{item.shortcut}</kbd>
              {/if}
            </button>
          </li>
        {:else}
          <li class="px-3.5 py-2 text-sm text-muted">
            {$t("palette.empty")}
          </li>
        {/each}
      </ul>
    </div>
  </Overlay>
{/if}

<style>
  .qcmd-item {
    color: var(--ui-fg);
  }
  .qcmd-item.qcmd-active {
    background: var(--ui-active-bg);
  }
  /* 快捷键徽标：inset 底 + 描边圆角，与 confirm 按钮描边风格一致 */
  .qcmd-key {
    flex: none;
    font-family: inherit;
    font-size: 11px;
    line-height: 1;
    padding: 3px 7px;
    border: 1px solid var(--ui-border);
    border-radius: 6px;
    background: var(--ui-inset);
    color: var(--ui-muted);
    letter-spacing: 0.3px;
    white-space: nowrap;
  }
</style>
