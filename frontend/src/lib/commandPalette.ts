/**
 * 命令面板：命令模型 + 全局开合状态 + GLOBAL_SHORTCUTS → 命令转换。
 *
 * 【命令来源】shortcuts.ts 导出的 GLOBAL_SHORTCUTS（纯声明式配置）转换为
 * 命令面板可用的结构：按 action 去重（同一 action 多组合合并展示，如
 * 重做 Ctrl+Shift+Z / Ctrl+Y），标题经 i18n（palette.* 组），快捷键由
 * combo 派生展示字符串。调出面板的快捷键（Ctrl+Shift+P）不进
 * GLOBAL_SHORTCUTS——它是「面板开关」而非面板命令，由 App.svelte 单独
 * 监听（toggle）。
 *
 * 【命令集扩展】GLOBAL_SHORTCUTS 之外的面板专属命令（如「归档图片文件到
 * 伴生资源目录」，无快捷键）追加在转换结果尾部，run 不经 actions 映射。
 *
 * 【开合状态】独立轻量 store（不随 stores.ts 导入链）：App.svelte 的
 * Ctrl+Shift+P 监听与 CommandPalette 组件消费；面板本身经 Overlay 基座
 * 注册进 overlayRegistry$（与设置面板 / 弹窗同口径，开启期间全局快捷键
 * 整链短路）。
 */
import { writable } from "svelte/store";
import {
  GLOBAL_SHORTCUTS,
  type ShortcutAction,
  type ShortcutCombo,
  type ShortcutActions,
} from "./shortcuts";
import { archiveImagesToCompanion } from "./imageArchive";

/** 开合状态（App 监听 toggle；组件 {#if} 消费） */
export const commandPaletteOpen$ = writable(false);

export function openCommandPalette(): void {
  commandPaletteOpen$.set(true);
}

export function closeCommandPalette(): void {
  commandPaletteOpen$.set(false);
}

/** 命令面板条目 */
export interface CommandItem {
  /** 稳定标识（列表 key / 调试用） */
  id: string;
  /** 标题 i18n 键（palette.* 组） */
  titleKey: string;
  /** 快捷键展示串（combo 派生；无快捷键命令为 ""） */
  shortcut: string;
  /** 执行：GLOBAL_SHORTCUTS 派生命令经 actions 映射调出既有处理器；
   *  面板专属命令直接调用业务流程（忽略 actions）。 */
  run: (actions: ShortcutActions) => void;
}

/** action → 标题 i18n 键（命令面板标题与快捷键语义分离：快捷键配置在
 *  shortcuts.ts，文案在此映射，两种语言共用同一键） */
const ACTION_TITLE_KEYS: Record<ShortcutAction, string> = {
  new: "palette.new",
  open: "palette.open",
  quit: "palette.quit",
  undo: "palette.undo",
  redo: "palette.redo",
  saveAs: "palette.saveAs",
  save: "palette.save",
  find: "palette.find",
};

/** 平台前缀：macOS 用 Cmd，Windows / Linux 用 Ctrl（与 shortcuts.ts 的
 *  mod 口径一致：mod = Ctrl(Win/Linux) / Cmd(macOS)） */
function modKey(): string {
  try {
    if (
      typeof navigator !== "undefined" &&
      /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent)
    ) {
      return "Cmd";
    }
  } catch {
    /* ignore */
  }
  return "Ctrl";
}

/** combo → 展示串（altDeny 是匹配约束「Alt 必须不按」，非组合成员，
 *  不参与展示） */
export function formatCombo(c: ShortcutCombo): string {
  const parts: string[] = [];
  if (c.mod) parts.push(modKey());
  if (c.shift) parts.push("Shift");
  parts.push(c.key.toUpperCase());
  return parts.join("+");
}

/**
 * GLOBAL_SHORTCUTS → 命令面板结构（每次调用重建，标题过滤组件内做）：
 * 按 action 去重保持配置顺序（数组顺序即优先级），同 action 的多组合
 * 合并进同一命令的 shortcut 展示；尾部追加面板专属命令（归档图片，
 * 无快捷键）。
 */
export function buildCommands(): CommandItem[] {
  const items: CommandItem[] = [];
  const byAction = new Map<ShortcutAction, CommandItem>();
  for (const spec of GLOBAL_SHORTCUTS) {
    const titleKey = ACTION_TITLE_KEYS[spec.action];
    if (!titleKey) continue;
    let item = byAction.get(spec.action);
    const comboText = formatCombo(spec.combo);
    if (!item) {
      item = {
        id: `command.${spec.action}`,
        titleKey,
        shortcut: comboText,
        run: (actions) =>
          actions[spec.action]?.(new KeyboardEvent("keydown")),
      };
      byAction.set(spec.action, item);
      items.push(item);
      continue;
    }
    // 同 action 多条 spec（redo Z / Y）：合并快捷键展示
    item.shortcut = `${item.shortcut} / ${comboText}`;
  }
  // 面板专属命令：归档图片文件到伴生资源目录（无快捷键）
  items.push({
    id: "command.archiveImages",
    titleKey: "palette.archiveImages",
    shortcut: "",
    run: () => void archiveImagesToCompanion(),
  });
  return items;
}
