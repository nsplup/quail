/**
 * 全局快捷键：声明式配置（可复用）+ 依赖注入安装器。
 *
 * 【分层】
 * - GLOBAL_SHORTCUTS：纯声明式配置（combo + action 标识 + 可选 when 守卫），
 *   不含任何处理器闭包 —— 可被任意模块 import 复用 / 扩展（注册更多 spec）
 *   或整体替换（不同场景装载不同 action 集）。数组顺序即优先级
 *   （首个匹配生效），注意保持 saveAs 先于 save 的约定；
 * - installGlobalShortcuts(actions)：把配置接到具体处理器（action →
 *   handler 映射）上，统一处理三件事：① 弹层守卫（overlayOpen$ 开启期间
 *   整链短路）；② 组合匹配（matchShortcut 纯函数）；③ preventDefault。
 *   App.svelte 只负责提供 action 处理器（save / openFile / spawnInstance
 *   等 App 装配函数），不在此模块依赖 App 内部逻辑。
 *
 * 【不抽象范围】CM6 keymap（codemirrorSetup.ts 的 Mod-s / Mod-f / Mod-z 等，
 * 与编辑器生命周期强绑定）、组件内部快捷键（searchPanel 文档级 Esc、
 * SettingsModal Esc capture、ContextMenu / TableInsertPopover /
 * MarkdownFootnoteRef 的 window 监听）——它们不是「全局兜底」语义，不进
 * 这份配置。
 *
 * 【组合匹配口径】key 取 e.key 的小写形式；mod = Ctrl(Win/Linux) /
 * Cmd(macOS)；shift: true=必须按 / false=必须不按 / undefined=不关心；
 * altDeny: true = Alt 必须不按（避免与 Alt 菜单助记键冲突）。
 */
import { get } from "svelte/store";
import { overlayOpen$ } from "./overlay";

/** 动作标识：声明「做什么」，具体「怎么做」由安装方注入（依赖解耦）。
 *  后续模块复用时可扩展此联合类型与对应处理器。 */
export type ShortcutAction =
  | "new"     // Ctrl/Cmd+N：拉起新实例
  | "open"    // Ctrl/Cmd+O：打开文档
  | "quit"    // Ctrl/Cmd+Q：关闭窗口（脏状态经 confirmDialog 守卫）
  | "undo"    // Ctrl/Cmd+Z：撤销（非 CM6 聚焦时兜底）
  | "redo"    // Ctrl/Cmd+Shift+Z / Ctrl/Cmd+Y：重做（非 CM6 聚焦时兜底）
  | "saveAs"  // Ctrl/Cmd+Shift+S：另存为
  | "save"    // Ctrl/Cmd+S：保存（全局兜底）
  | "find";   // Ctrl/Cmd+F：查找替换悬浮面板（全局兜底）

export interface ShortcutCombo {
  key: string;
  /** Ctrl(Win/Linux) / Cmd(macOS) */
  mod: boolean;
  /** true=必须按 / false=必须不按 / undefined=不关心 */
  shift?: boolean;
  /** true = Alt 必须不按（与浏览器/系统 Alt 菜单助记键区分） */
  altDeny?: boolean;
}

export interface ShortcutSpec {
  /** 稳定标识，便于调试与后续模块按 id 查找/去重 */
  id: string;
  combo: ShortcutCombo;
  action: ShortcutAction;
  /** 可选前置守卫：返回 false 则跳过本条（终止匹配链）。
   *  用于 defaultPrevented 检查（CM6 已处理的按键不重复响应）与
   *  CM6 / 原生输入控件焦点检查（不劫持其自身快捷键语义）。 */
  when?: (e: KeyboardEvent) => boolean;
}

/** action → 处理器映射（部分即可；缺省动作视为未安装，匹配到即忽略） */
export type ShortcutActions = Partial<
  Record<ShortcutAction, (e: KeyboardEvent) => void>
>;

/**
 * 撤销/重做共享守卫（undo / redoZ / redoY 三条 spec 复用）：
 * - 焦点在任意 CM6 实例内 → 交由 CM6 自身 keymap（Mod-z / Mod-y）处理，
 *   此处不拦截（original if 链的 .cm-editor closest 检查）；
 * - 焦点在原生输入控件（input / textarea / contentEditable）→ 保留其
 *   原生撤销语义，不劫持；
 * - 其余焦点（预览区 / 查找面板卡片 / 无焦点）→ 由编辑区 CM6 实例兜底。
 */
export function notInEditableFocus(e: KeyboardEvent): boolean {
  const target = e.target instanceof Element ? e.target : null;
  if (target?.closest(".cm-editor")) return false;
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  ) {
    return false;
  }
  return true;
}

/** defaultPrevented 守卫：事件已被下层（如 CM6 keymap）处理时不重复响应 */
function notDefaultPrevented(e: KeyboardEvent): boolean {
  return !e.defaultPrevented;
}

/**
 * 全局快捷键配置（可复用）。
 *
 * 顺序即优先级：首个 combo 匹配的 spec 生效 —— saveAs 必须排在 save 之前。
 * 各条详细口径：
 * - new / open / quit：编辑器无关的全局动作，任何焦点状态均响应
 *   （弹层开启期间除外，由安装器统一守卫）；
 * - undo / redo：见 notInEditableFocus 注释；
 * - saveAs：无守卫 —— CM6 keymap 未注册 Mod-Shift-S，不存在冲突；
 * - save：全局保存兜底。CM6 聚焦时其 keymap（Mod-s）已处理并
 *   preventDefault，事件冒泡到 window 时 defaultPrevented 为 true，此处
 *   跳过避免双重保存；非 CM6 聚焦状态（预览区 / 查找面板输入框 /
 *   设置面板 / 无焦点）由此触发保存；
 * - find：全局打开查找替换悬浮面板（右上角卡片，独立于编辑区挂载点，
 *   预览模式无需切回双栏）。CM6 聚焦时其 keymap（Mod-f）已处理并
 *   preventDefault，此处跳过；非 CM6 聚焦状态由此触发：预览区有单行
 *   选区则填入关键词框；面板已开时仅聚焦（选区拉取在处理器侧完成）。
 */
export const GLOBAL_SHORTCUTS: ShortcutSpec[] = [
  {
    id: "global.new",
    combo: { key: "n", mod: true },
    action: "new",
  },
  {
    id: "global.open",
    combo: { key: "o", mod: true },
    action: "open",
  },
  {
    id: "global.quit",
    combo: { key: "q", mod: true },
    action: "quit",
  },
  {
    id: "global.undo",
    combo: { key: "z", mod: true, shift: false, altDeny: true },
    action: "undo",
    when: notInEditableFocus,
  },
  {
    id: "global.redoZ",
    combo: { key: "z", mod: true, shift: true, altDeny: true },
    action: "redo",
    when: notInEditableFocus,
  },
  {
    // Mod+Shift+Y 与 Mod+Y 同为重做（shift 不设限，与原 if 链口径一致）
    id: "global.redoY",
    combo: { key: "y", mod: true, altDeny: true },
    action: "redo",
    when: notInEditableFocus,
  },
  {
    id: "global.saveAs",
    combo: { key: "s", mod: true, shift: true },
    action: "saveAs",
  },
  {
    id: "global.save",
    combo: { key: "s", mod: true, shift: false, altDeny: true },
    action: "save",
    when: notDefaultPrevented,
  },
  {
    id: "global.find",
    combo: { key: "f", mod: true, shift: false, altDeny: true },
    action: "find",
    when: notDefaultPrevented,
  },
];

/**
 * 组合匹配（纯函数）：按 combo 口径比对键盘事件。
 * 仅供安装器与单测使用；不读取 overlay 状态（守卫在安装器内统一做）。
 */
export function matchShortcut(
  spec: ShortcutSpec,
  e: Pick<
    KeyboardEvent,
    "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey"
  >,
): boolean {
  const c = spec.combo;
  if (e.key.toLowerCase() !== c.key) return false;
  const mod = e.ctrlKey || e.metaKey;
  if (c.mod !== mod) return false;
  if (c.shift !== undefined && e.shiftKey !== c.shift) return false;
  if (c.altDeny && e.altKey) return false;
  return true;
}

/**
 * 安装全局快捷键：window keydown 监听 + 声明式配置 + 处理器注入。
 * 返回注销函数（$effect cleanup 直通）。
 *
 * 执行序（与原 App.svelte if 链等价）：
 * 1. 弹层守卫：任一遮罩开启（overlayOpen$）→ 整链短路；
 * 2. 按 GLOBAL_SHORTCUTS 顺序匹配 combo；when 守卫拒绝 → 终止（不落后续
 *    条目 —— 与原 if-else 链「同一按键组内早退」口径一致）；
 * 3. action 未注册处理器 → 忽略（防误触）；
 * 4. preventDefault 后调用处理器。
 */
export function installGlobalShortcuts(
  actions: ShortcutActions,
  specs: ShortcutSpec[] = GLOBAL_SHORTCUTS,
): () => void {
  const onKey = (e: KeyboardEvent): void => {
    /* ---- 弹层守卫：任一遮罩（设置面板 / confirm 弹窗）打开期间 ---- */
    if (get(overlayOpen$)) return;
    for (const spec of specs) {
      if (!matchShortcut(spec, e)) continue;
      if (spec.when && !spec.when(e)) return;
      const handler = actions[spec.action];
      if (!handler) return;
      e.preventDefault();
      handler(e);
      return;
    }
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}
