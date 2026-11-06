/**
 * Promise 化确认对话框：confirmDialog(msg, mode?) 弹窗等待用户选择。
 *
 * - dirty 模式（默认）：保存 / 丢弃 / 取消 三按钮，用于脏状态流程
 *   （关闭确认、打开/拖拽替换文档确认）；保存 = 先落盘再继续被拦截操作；
 * - confirm 模式：确定 / 取消，用于保存冲突覆盖等二选确认；
 * - deletedSave 模式：仍然保存 / 取消，用于「文件已被外部删除仍要保存」
 *   的确认（仍然保存会覆盖重建原路径文件）。
 *
 * Esc 映射为「取消」（安全侧，防止误触丢失修改），焦点圈定与 Tab 循环
 * 由 focus-trap 接管（ConfirmDialog 内通过 lib/focusTrap.ts 的 attachment
 * 包装使用），按钮使用浏览器默认 focus outline；
 * 键盘映射、按钮图标由 ConfirmDialog 组件实现。
 */
import { writable } from "svelte/store";

export type ConfirmMode = "dirty" | "confirm" | "deletedSave";

export type ConfirmResult = "save" | "discard" | "ok" | "cancel";

interface ConfirmState {
  msg: string;
  mode: ConfirmMode;
  resolve: (v: ConfirmResult) => void;
}

export const confirm$ = writable<ConfirmState | null>(null);

/** 弹出确认框：resolve("save")=保存后继续 / "discard"|"ok"=直接继续 / "cancel"=取消 */
export function confirmDialog(
  msg: string,
  mode: ConfirmMode = "dirty"
): Promise<ConfirmResult> {
  return new Promise((resolve) => {
    confirm$.set({ msg, mode, resolve });
  });
}
