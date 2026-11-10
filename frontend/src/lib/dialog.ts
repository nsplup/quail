/**
 * Promise 化 Dialog 接口（lib/confirm.ts 的重构继任者）。
 *
 * - Dialog.confirm({ msg, buttons? })：可配置按钮的确认框（默认确定 /
 *   取消两按钮），Promise 化等待用户选择；Esc / 遮罩点击经 dismissValue
 *   （默认 "cancel"）安全侧关闭；
 * - Dialog.progress({ msg, buttons?, minDurationMs? })：长耗时任务状态框，
 *   遮罩无法被任何交互关闭（无遮罩点击关闭、Esc 不触发关闭），只能由
 *   业务方调用 handle.finish() 结束（结束后至少停留 minDurationMs，
 *   默认 500ms）或用户点击配置的按钮（默认无按钮）提前结束；
 *   返回 handle：{ promise, finish(), update(msg) }——promise resolve
 *   值为被点击按钮的 value；finish() 正常结束（无按钮点击）resolve("")，
 *   调用方据此区分「已完成」与「用户取消」。
 *
 * 可配置按钮（DialogButton）：{ value, label, icon? }，icon 复用 Icon.svelte
 * 现有描边图标名（floppy / trash / close）。
 *
 * confirm$ / progress$ 落 store 前先 await Window.Focus()（@wailsio/runtime）：
 * 弹窗常由后台事件触发（如 close:request 拦截关闭流程、粘贴长耗时超时），
 * 窗口可能处于未聚焦状态；先把 webview 拉回前台焦点再落 store，保证弹窗
 * 渲染后 Esc / Enter / Tab 可即时操作。聚焦失败（纯浏览器 dev / 运行时桥
 * 不可用）静默忽略，不阻断弹窗流程。
 *
 * 旧 confirmDialog(msg, mode) 签名已删除：消费方一律迁移至本模块
 * （App.svelte 三处调用 + searchPanel / SettingsModal 守卫）。
 */
import { Window } from "@wailsio/runtime";
import { writable } from "svelte/store";
import { get } from "svelte/store";
import { t } from "./i18n.svelte";

/** 可配置按钮：value 为 Dialog.confirm 的 resolve 值 */
export type DialogButton = {
  value: string;
  label: string;
  icon?: string;
};

export interface ConfirmState {
  msg: string;
  buttons: DialogButton[];
  /** Esc / 遮罩点击的兜底 resolve 值（安全侧） */
  dismissValue: string;
  resolve: (v: string) => void;
}

interface ProgressState {
  msg: string;
  buttons: DialogButton[];
  resolve: (v: string) => void;
}

export const confirm$ = writable<ConfirmState | null>(null);
export const progress$ = writable<ProgressState | null>(null);

/** 默认两按钮：确定 / 取消（confirm 未传 buttons 时） */
function defaultConfirmButtons(): DialogButton[] {
  const tr = get(t);
  return [
    { value: "ok", label: tr("confirm.ok") },
    { value: "cancel", label: tr("common.cancel"), icon: "close" },
  ];
}

/** 弹出确认框：resolve 为被点击按钮的 value；Esc / 遮罩点击 → dismissValue */
export function dialogConfirm(options: {
  msg: string;
  buttons?: DialogButton[];
  dismissValue?: string;
}): Promise<string> {
  return new Promise((resolve) => {
    void (async () => {
      try {
        await Window.Focus();
      } catch {
        /* 非 wails 环境（纯浏览器 dev / 运行时桥不可用）：忽略聚焦失败 */
      }
      confirm$.set({
        msg: options.msg,
        buttons: options.buttons ?? defaultConfirmButtons(),
        dismissValue: options.dismissValue ?? "cancel",
        resolve,
      });
    })();
  });
}

/** Dialog.progress 句柄：finish 正常结束；update 更新进度文案 */
export interface DialogProgressHandle {
  /** resolve 值：被点击按钮的 value；finish() 正常结束 → "" */
  promise: Promise<string>;
  /** 正常结束（幂等）：关闭前至少停留 minDurationMs（自打开起算） */
  finish(): void;
  /** 更新进度文案 */
  update(msg: string): void;
}

/**
 * 弹出长耗时任务状态框：遮罩不可交互关闭（Dialog.svelte 的 progress
 * 面板无遮罩点击回调、focus-trap escapeDeactivates: false），只能由
 * 业务方 finish() 或用户点击配置按钮（默认无按钮）结束。
 */
export function dialogProgress(options: {
  msg: string;
  buttons?: DialogButton[];
  /** 关闭前最小停留时长（ms，自打开起算，默认 500ms） */
  minDurationMs?: number;
}): DialogProgressHandle {
  let resolveFn: (v: string) => void = () => {};
  const promise = new Promise<string>((resolve) => {
    resolveFn = resolve;
  });
  let closed = false;
  let finishTimer: ReturnType<typeof setTimeout> | null = null;
  const minDurationMs = options.minDurationMs ?? 500;
  const openAt = Date.now();

  const close = (value: string) => {
    if (closed) return;
    closed = true;
    if (finishTimer !== null) clearTimeout(finishTimer);
    progress$.set(null);
    resolveFn(value);
  };

  void (async () => {
    try {
      await Window.Focus();
    } catch {
      /* 忽略聚焦失败，同 dialogConfirm */
    }
    progress$.set({
      msg: options.msg,
      buttons: options.buttons ?? [],
      resolve: (v) => close(v), // 按钮点击：立即结束（不受最小停留约束）
    });
  })();

  return {
    promise,
    finish() {
      if (closed) return;
      const elapsed = Date.now() - openAt;
      const wait = Math.max(0, minDurationMs - elapsed);
      finishTimer = setTimeout(() => close(""), wait);
    },
    update(msg: string) {
      if (closed) return;
      progress$.update((s) => (s ? { ...s, msg } : s));
    },
  };
}

/** 命名空间出口（消费方统一 Dialog.confirm / Dialog.progress 调用） */
export const Dialog = {
  confirm: dialogConfirm,
  progress: dialogProgress,
};
