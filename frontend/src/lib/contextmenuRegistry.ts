/**
 * 全局右键菜单注册表：统一 contextmenu 事件分发。
 *
 * 事件监听从各持有组件迁移到文档根：App 启动时装载唯一一个 capture 阶段
 * 的 document contextmenu 监听（installGlobalContextMenuDispatcher），所有
 * 想弹自定义菜单的目标改为向本注册表注册（registerContextMenuTarget）。
 * 分发规则：
 *  1. 事件落在已打开的菜单浮层内 → 仅阻止默认行为（不重建、不关闭）；
 *  2. 收集所有包含事件目标的注册目标，按 DOM 深度降序（最内层优先）
 *     逐个询问 resolver：
 *       - 返回菜单 → 阻止默认并打开，结束；
 *       - 返回 CONTEXT_MENU_PASSTHROUGH → 本目标不处理，继续向外层询问；
 *       - 返回 null → 目标已注册但当前条件不成立：阻止默认，结束；
 *  3. 全部候选都 passthrough / 没有注册目标 → 开发模式放行，生产阻止。
 *
 * resolver 在事件分发时同步调用：可闭包捕获组件当前状态（如图片加载
 * 态、编辑器可写性），开启条件在调用时刻求值，无需重复注册。
 */
import { openContextMenu, type ContextMenuItem } from "./contextmenu";

/** resolver 产物：菜单项与可选的锚点/关闭回调（与 openContextMenu 对齐） */
export interface ContextMenuResolve {
  items: ContextMenuItem[];
  options?: { onClosed?: () => void; anchor?: Element };
}

/** resolver 返回此标记 = 本目标当前不处理，请继续向外层注册目标询问 */
export const CONTEXT_MENU_PASSTHROUGH: unique symbol =
  Symbol("contextmenu-passthrough");

export type ResolverResult =
  | ContextMenuResolve
  | null
  | typeof CONTEXT_MENU_PASSTHROUGH;

type Resolver = (ev: MouseEvent) => ResolverResult;

interface RegistryEntry {
  target: Element;
  resolve: Resolver;
}

const entries = new Set<RegistryEntry>();
let menuRoot: Element | null = null;
let installed = false;

/** ContextMenu.svelte 在菜单开合时上报浮层根元素（null = 已关闭） */
export function setContextMenuRootElement(el: Element | null): void {
  menuRoot = el;
}

/**
 * 注册触发目标：target 子树内（含自身）的 contextmenu 事件由 resolve
 * 决定菜单内容。返回注销函数（组件销毁时调用）。
 */
export function registerContextMenuTarget(
  target: Element,
  resolve: Resolver,
): () => void {
  install();
  const entry: RegistryEntry = { target, resolve };
  entries.add(entry);
  return () => {
    entries.delete(entry);
  };
}

/** 元素在 DOM 树中的深度（根为 1）。祖先链上深度越大越靠近事件目标。 */
function domDepth(el: Element): number {
  let d = 0;
  for (let n: Element | null = el; n; n = n.parentElement) d++;
  return d;
}

/** 是否处于开发者模式：开发模式下放行未注册目标的默认右键菜单 */
function isDeveloperMode(): boolean {
  try {
    // Vite：构建时静态替换，生产构建中 DEV 为 false
    const env = (import.meta as any).env;
    if (env && typeof env.DEV === "boolean") return env.DEV;
  } catch {
    /* 非 ESM / 非 Vite 环境，忽略 */
  }
  // 兜底：视为生产模式
  return false;
}

function onContextMenu(ev: MouseEvent): void {
  const target = ev.target;
  if (!(target instanceof Node)) return;

  /* 1. 菜单浮层自身：拦截系统菜单，不重建不关闭 */
  if (menuRoot && menuRoot.contains(target)) {
    ev.preventDefault();
    return;
  }

  /* 2. 收集所有包含事件目标的注册目标，按深度降序排列 */
  const candidates: RegistryEntry[] = [];
  for (const e of entries) {
    if (e.target.contains(target)) candidates.push(e);
  }
  if (candidates.length > 1) {
    candidates.sort((a, b) => domDepth(b.target) - domDepth(a.target));
  }

  /* 3. 最内层优先，passthrough 时继续向外层询问 */
  for (const entry of candidates) {
    const resolved = entry.resolve(ev);
    if (resolved === CONTEXT_MENU_PASSTHROUGH) continue;
    if (!resolved) {
      /* 已注册但条件不成立：保持原语义，阻止系统菜单 */
      if (!isDeveloperMode()) ev.preventDefault();
      return;
    }
    ev.preventDefault();
    openContextMenu(ev.clientX, ev.clientY, resolved.items, resolved.options);
    return;
  }

  /* 4. 无注册目标 / 全部 passthrough：按开发 / 生产分流 */
  if (!isDeveloperMode()) ev.preventDefault();
}

function install(): void {
  if (installed) return;
  installed = true;
  /* capture：先于目标元素上任何残留的 contextmenu 监听执行 */
  document.addEventListener("contextmenu", onContextMenu, true);
}

/** App 启动时装载全局分发器（main.ts 调用一次） */
export function installGlobalContextMenuDispatcher(): void {
  install();
}
