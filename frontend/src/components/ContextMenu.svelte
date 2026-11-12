<script lang="ts">
  /**
   * ContextMenu：全局右键菜单（当前界面风格浮层）。
   *
   * - 状态由 lib/contextmenu 的 contextMenu$ 持有，App 层单实例挂载；
   * - 定位：以光标坐标为基准，渲染后按实测尺寸向视口内收敛（右/下边缘
   *   8px 安全边距），避免长菜单溢出视口；
   * - 关闭时机：选中项、菜单外按下、Esc、容器滚动、窗口 resize / blur——
   *   滚动后菜单与目标脱节，直接关闭；提供锚点（anchor）时按锚点作用域
   *   过滤：仅锚点子树内的滚动才关闭，无关面板滚动（如编辑器光标同步
   *   驱动的预览滚动）不关闭；
   * - 菜单内 contextmenu 事件就地拦截：菜单上再右键不闪出系统菜单、
   *   也不重建菜单（避免关闭→重开抖动）；
   * - 菜单项图标：始终渲染固定尺寸的图标槽位，无 icon 时留空占位，
   *   保证有/无图标项的 label 起始位置一致（槽位宽 = 图标尺寸，由
   *   MENU_ICON_SIZE 单一来源驱动）。
   */
  import { tick } from "svelte";
  import { get } from "svelte/store";
  import Icon from "./Icon.svelte";
  import {
    contextMenu$,
    closeContextMenu,
    type ContextMenuItem,
  } from "../lib/contextmenu";

  /** 菜单图标边长（px）。图标槽位与 Icon 共用此值，避免两处硬编码错位。 */
  const MENU_ICON_SIZE = 14;

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
    const onScroll = (ev: Event) => {
      // 滚动关闭按锚点作用域过滤：提供 anchor 时仅当滚动目标在锚点子树内
      // （锚点随滚动移动，菜单与目标脱节）才关闭；无关面板的滚动（如光标
      // 同步驱动的预览面板滚动）忽略，避免编辑器右键菜单被联动滚动误关。
      // 无锚点菜单（图片/表格等）保持旧行为：任何滚动即关。
      const anchor = get(contextMenu$)?.anchor;
      if (!anchor) {
        closeContextMenu();
        return;
      }
      if (ev.target instanceof Node && anchor.contains(ev.target)) {
        closeContextMenu();
      }
    };
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
    class="ctx-menu fixed z-[70] min-w-[176px] rounded-lg border border-line bg-soft py-1 shadow-lg select-none"
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
        <div
          class="ctx-separator my-1 border-t border-line"
          role="separator"
        ></div>
      {:else if item.kind === "header"}
        <!-- 分组标题：非交互项，不关闭菜单 -->
        <div
          class="ctx-header px-3 pb-1 pt-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-muted"
          role="presentation"
        >
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
          onmousedown={(ev) => {
            // mousedown 不转移焦点：编辑器右键菜单的菜单项动作（粘贴/
            // 剪切/全选）依赖编辑器保持焦点——单元格编辑器失焦即提交，
            // 焦点一旦移到菜单上，动作将作用于已提交卸载的视图而丢失
            ev.preventDefault();
          }}
        >
          <!-- 图标槽位：始终渲染、固定宽高（= 图标尺寸），无 icon 时留空
               占位，使有/无图标项的 label 起始位置一致；宽度不因空内容
               被 flex 收缩，故 flex-none。 -->
          <span
            class="flex-none inline-flex items-center justify-center text-muted"
            style="width: {MENU_ICON_SIZE}px; height: {MENU_ICON_SIZE}px;"
          >
            {#if item.icon}
              <Icon name={item.icon} size={MENU_ICON_SIZE} />
            {/if}
          </span>
          <span class="truncate">{item.label}</span>
        </button>
      {/if}
    {/each}
  </div>
{/if}
