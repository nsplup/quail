/**
 * 右键菜单状态：全局单实例（App 层挂载 ContextMenu 组件渲染）。
 *
 * - 菜单为受控浮层：openContextMenu(x, y, items) 记录光标位置与菜单项，
 *   由 ContextMenu 组件订阅渲染，避免每张图片各自挂一份 DOM；
 * - 固定定位浮在视口上（虚拟滚动列表的 absolute 定位祖先不构成包含块），
 *   组件内部负责视口边缘收敛与关闭（外点 / Esc / 滚动 / 失焦）；
 * - 动作（action 回调）由调用方闭包注入，本模块只承载状态，不感知具体行为。
 */
import { get, writable } from "svelte/store";

/**
 * 菜单项：icon 为 Icon.svelte 手写图标名；disabled 项仅置灰不可触发。
 * kind（可选）扩展非交互项：
 * - "header"：分组标题（小号加粗标签，不可点击、不关闭菜单）；
 * - "separator"：分组分隔线。
 * 二者无需 action；缺省视为普通可点项。
 */
export interface ContextMenuItem {
  icon?: string;
  label: string;
  disabled?: boolean;
  action?: () => void;
  kind?: "item" | "header" | "separator";
}

interface ContextMenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
  /** 菜单收起时回调（选中/外点/Esc/滚动/失焦/被新菜单覆盖） */
  onClosed?: () => void;
}

/** 安全触发关闭回调：防止调用方回调抛错影响状态机 */
function notifyClosed(state: ContextMenuState | null): void {
  if (!state?.onClosed) return;
  try {
    state.onClosed();
  } catch (err) {
    console.error("[contextMenu] onClosed threw:", err);
  }
}

export const contextMenu$ = writable<ContextMenuState | null>(null);

/** 打开右键菜单（重复调用直接覆盖：右键另一目标时即时换菜单） */
export function openContextMenu(
  x: number,
  y: number,
  items: ContextMenuItem[],
  options?: { onClosed?: () => void },
): void {
  const prev = get(contextMenu$);           // 1. 取出旧状态（同步）

  contextMenu$.set({                        // 2. 新状态先落地
    x,
    y,
    items,
    onClosed: options?.onClosed,
  });

  // 3. 再通知旧菜单关闭：此时 store 里已是新菜单，
  //    旧回调即使误清引用也不会把新菜单"关掉"
  notifyClosed(prev);
}

/** 关闭右键菜单（选中项、外点、Esc、滚动、窗口失焦均走这里） */
export function closeContextMenu(): void {
  const prev = get(contextMenu$);
  if (!prev) return;

  contextMenu$.set(null);                   // 先清状态，再回调
  notifyClosed(prev);
}