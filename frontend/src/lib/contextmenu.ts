/**
 * 右键菜单状态：全局单实例（App 层挂载 ContextMenu 组件渲染）。
 *
 * - 菜单为受控浮层：openContextMenu(x, y, items) 记录光标位置与菜单项，
 *   由 ContextMenu 组件订阅渲染，避免每张图片各自挂一份 DOM；
 * - 固定定位浮在视口上（虚拟滚动列表的 absolute 定位祖先不构成包含块），
 *   组件内部负责视口边缘收敛与关闭（外点 / Esc / 滚动 / 失焦）；
 * - 动作（action 回调）由调用方闭包注入，本模块只承载状态，不感知具体行为。
 */
import { writable } from "svelte/store";

/** 菜单项：icon 为 Icon.svelte 手写图标名；disabled 项仅置灰不可触发 */
export interface ContextMenuItem {
  icon?: string;
  label: string;
  disabled?: boolean;
  action: () => void;
}

interface ContextMenuState {
  /** 光标位置（视口坐标，组件内做边缘收敛） */
  x: number;
  y: number;
  items: ContextMenuItem[];
}

export const contextMenu$ = writable<ContextMenuState | null>(null);

/** 打开右键菜单（重复调用直接覆盖：右键另一目标时即时换菜单） */
export function openContextMenu(x: number, y: number, items: ContextMenuItem[]): void {
  contextMenu$.set({ x, y, items });
}

/** 关闭右键菜单（选中项、外点、Esc、滚动、窗口失焦均走这里） */
export function closeContextMenu(): void {
  contextMenu$.set(null);
}
