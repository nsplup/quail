/**
 * Promise 化确认对话框：confirmDialog(msg) 弹窗等待用户选择。
 * 供"关闭确认"与"保存冲突覆盖确认"共用。
 */
import { writable } from "svelte/store";

interface ConfirmState {
  msg: string;
  resolve: (v: boolean) => void;
}

export const confirm$ = writable<ConfirmState | null>(null);

/** 弹出确认框，resolve(true)=确认 / false=取消 */
export function confirmDialog(msg: string): Promise<boolean> {
  return new Promise((resolve) => {
    confirm$.set({ msg, resolve });
  });
}
