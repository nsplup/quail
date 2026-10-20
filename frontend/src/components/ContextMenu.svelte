<script lang="ts">
  /**
   * ContextMenu：全局右键菜单（当前界面风格浮层）。
   *
   * - 状态由 lib/contextmenu 的 contextMenu$ 持有，App 层单实例挂载；
   * - 定位：以光标坐标为基准，渲染后按实测尺寸向视口内收敛（右/下边缘
   *   8px 安全边距），避免长菜单溢出视口；
   * - 关闭时机：选中项、菜单外按下、Esc、任意容器滚动（capture 捕获预览
   *   面板滚动）、窗口 resize / blur——滚动后菜单与目标脱节，直接关闭；
   * - 菜单内 contextmenu 事件就地拦截：菜单上再右键不闪出系统菜单、
   *   也不重建菜单（避免关闭→重开抖动）。
   */
  import { tick } from "svelte";
  import Icon from "./Icon.svelte";
  import { contextMenu$, closeContextMenu, type ContextMenuItem } from "../lib/contextmenu";

  const contextMenuState = $derived($contextMenu$);

  let menuEl = $state<HTMLDivElement | null>(null);
  /** 收敛后的实际渲染位置（首帧用光标坐标渲染，实测后更新） */
  let pos = $state({ x: -9999, y: -9999 });

  // 打开后：先落到光标坐标，实测尺寸后向视口内收敛并聚焦首个可用项
  $effect(() => {
    if (!contextMenuState) return;
    const raw = contextMenuState;
    pos = { x: raw.x, y: raw.y };
    tick().then(() => {
      const el = menuEl;
      if (!el) return;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      pos = {
        x: Math.max(8, Math.min(raw.x, window.innerWidth - w - 8)),
        y: Math.max(8, Math.min(raw.y, window.innerHeight - h - 8)),
      };
    });
  });

  // 打开期间的全局监听（关闭时机见组件头注释）
  $effect(() => {
    if (!contextMenuState) return;
    const onKeydown = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        closeContextMenu();
      }
    };
    const onPointerDown = (ev: PointerEvent) => {
      const el = menuEl;
      if (el && ev.target instanceof Node && el.contains(ev.target)) return;
      closeContextMenu();
    };
    const onScroll = () => closeContextMenu();
    const onResize = () => closeContextMenu();
    const onBlur = () => closeContextMenu();
    window.addEventListener("keydown", onKeydown);
    window.addEventListener("pointerdown", onPointerDown, true);
    // scroll 不冒泡：capture 才能吃到预览面板滚动容器的滚动
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeydown);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("blur", onBlur);
    };
  });

  function itemClick(item: ContextMenuItem): void {
    if (item.disabled) return;
    closeContextMenu();
    item.action?.();
  }
</script>

{#if contextMenuState}
  <!-- 浮层与主题 token 对齐全局：bg-soft 底、line 描边、12px 圆角、
       text-xs 字号（与 Toast / 设置面板同级密度）；z 层压过 Toast(60) -->
  <!-- svelte-ignore a11y_interactive_supports_focus -->
  <div
    class="ctx-menu fixed z-[70] min-w-[176px] rounded-lg border border-line bg-soft py-1 shadow-lg"
    style="left: {pos.x}px; top: {pos.y}px;"
    bind:this={menuEl}
    role="menu"
    aria-orientation="vertical"
    oncontextmenu={(ev) => {
      // 菜单自身区域的右键：拦截系统菜单，不重建菜单
      ev.preventDefault();
      ev.stopPropagation();
    }}
  >
    {#each contextMenuState.items as item, i (i)}
      {#if item.kind === "separator"}
        <!-- 分组分隔线：非交互项，不关闭菜单 -->
        <div class="ctx-separator my-1 border-t border-line" role="separator"></div>
      {:else if item.kind === "header"}
        <!-- 分组标题：非交互项，不关闭菜单 -->
        <div class="ctx-header px-3 pb-1 pt-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-muted" role="presentation">
          {item.label}
        </div>
      {:else}
        <button
          class="ctx-item flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-fg transition-colors duration-150 hover:bg-hover focus:bg-hover focus:outline-none disabled:pointer-events-none disabled:opacity-40"
          type="button"
          role="menuitem"
          tabindex="-1"
          disabled={item.disabled ?? false}
          onclick={() => itemClick(item)}
        >
          {#if item.icon}
            <span class="flex-none text-muted"><Icon name={item.icon} size={14} /></span>
          {/if}
          <span class="truncate">{item.label}</span>
        </button>
      {/if}
    {/each}
  </div>
{/if}
