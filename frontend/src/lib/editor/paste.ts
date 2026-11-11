/**
 * 应用层粘贴处理器（App.svelte 启动时经 installAppPasteHandler 注册，
 * CM6 paste 域事件经 pasteHandler 注册表路由至此；主编辑器与单元格
 * 编辑器共用同一处理器，插入一律作用于收到粘贴事件的视图）。
 *
 * 剪贴板数据不经前端 ClipboardEvent 读取：统一交由后端完成"探测 + 校验"，
 * 图片字节的落盘延迟到路径守卫通过后由 commitClipboardImage 二次调用后端完成。
 *
 * 分派流程（同步阶段一律 preventDefault 并返回 true）：
 *  1. 后端 ReadClipboard（图片只做校验 + 内存暂存，不落盘）：
 *     - kind=image & ok=false：按 reason 弹 TOAST（format / size），结束；
 *     - kind=image & ok=true：先 ensureDocSaved 触发路径守卫（取消 → 中断
 *       本次图片插入，无文件产生），再 commitClipboardImage 落盘，最后
 *       insertImages 插入收件视图；
 *     - kind=html：SHIFT 按下 → 丢弃样式；无 SHIFT → 保留语义映射——两者
 *       均经 insertHtmlAsMarkdown 作用于传入的 cmView；
 *     - kind=text：纯文本替换当前选区；
 *     - kind=empty：无消费内容，动作结束。
 *  2. 后端读取 / 落盘超阈值进入 Dialog.progress（取消按钮 + 最小停留
 *     500ms）；用户点取消 → call.cancel() 取消后端 context.Context，
 *     整条操作链路被打断（取消后结果静默丢弃；落盘取消时暂存槽位保留）。
 *     落盘段仅在实际超阈值时弹框（快路径无感）。
 *
 * SHIFT 业务语义：SHIFT 粘贴 = "无样式纯文本"（仅对 html 分支生效）；
 * SHIFT 状态由独立的键盘事件（keydown/keyup + blur 重置）跟踪，不依赖
 * ClipboardEvent.shiftKey，以覆盖菜单粘贴、程序化触发 paste 等场景。
 */
import type { EditorView } from "@codemirror/view";
import { get } from "svelte/store";
import { registerPasteHandler } from "./pasteHandler";
import { htmlToMarkdown } from "./htmlToMarkdown";
import { ensureDocSaved, insertImages } from "../imageInsert";
import { Dialog, type DialogProgressHandle } from "../dialog";
import { toast$ } from "../stores";
import {
  readClipboard,
  commitClipboardImage,
  type ClipboardPayload,
  type ImportedImage,
} from "../bridge";
import { t } from "../i18n.svelte";

/** 后端读取响应等待阈值：超过则进入长耗时任务状态 */
const READ_TIMEOUT_MS = 300;

/** 落盘响应等待阈值：超过则进入长耗时任务状态（同读取口径，快路径无感） */
const SAVE_PROGRESS_DELAY_MS = 300;

/** SHIFT 物理按键状态：独立键盘事件跟踪（菜单/程序化粘贴时 shiftKey 不可靠） */
let shiftPressed = false;
let detachKeyboard: (() => void) | null = null;

/** 注册应用层粘贴处理器；返回注销函数（同时清理键盘监听） */
export function installAppPasteHandler(): () => void {
  detachKeyboard?.();

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Shift") shiftPressed = true;
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.key === "Shift") shiftPressed = false;
  };
  const onBlur = () => {
    shiftPressed = false;
  };
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  window.addEventListener("blur", onBlur);

  const detach = () => {
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("keyup", onKeyUp, true);
    window.removeEventListener("blur", onBlur);
  };
  detachKeyboard = detach;

  const unregister = registerPasteHandler((event, view) => {
    const cmView = view as EditorView | null;
    if (!cmView) return false;
    /* 决策依赖后端往返：同步阶段一律拦截默认粘贴，异步按 payload 行为化 */
    event.preventDefault();
    void handlePaste(cmView, shiftPressed);
    return true;
  });

  return () => {
    unregister();
    detach();
    if (detachKeyboard === detach) detachKeyboard = null;
  };
}

/** 粘贴链路主体：后端读取 → 按 payload 分派（调用方已 preventDefault） */
async function handlePaste(view: EditorView, shift: boolean): Promise<void> {
  const tr = get(t);

  let payload: ClipboardPayload;
  /* 用对象引用承载可变状态：TS 不跟踪 setTimeout 回调内的赋值，
     若直接用 let，finally 中会被窄化为 null（分支内变 never）。 */
  const progressRef: { current: DialogProgressHandle | null } = { current: null };
  const abortedRef = { current: false };

  const call = readClipboard();
  const timer = setTimeout(() => {
    if (progressRef.current) return;
    const handle = Dialog.progress({
      msg: tr("progress.readingClipboard"),
      buttons: [
        { value: "cancel", label: tr("common.cancel"), icon: "close" },
      ],
      minDurationMs: 500,
    });
    progressRef.current = handle;
    void handle.promise.then((value) => {
      if (value === "cancel") {
        abortedRef.current = true;
        call.cancel(); // 取消后端读取（context.Context），任务可被打断
      }
    });
  }, READ_TIMEOUT_MS);

  try {
    payload = await call;
  } catch {
    if (!abortedRef.current) {
      toast$.set({ id: Date.now(), msg: tr("toast.imageReadFailed") });
    }
    return;
  } finally {
    clearTimeout(timer);
    const handle = progressRef.current;
    if (handle) {
      handle.finish();
      await handle.promise;
    }
  }

  if (abortedRef.current) return;

  switch (payload.kind) {
    case "image":
      await handleImagePayload(payload, view);
      return;
    case "html":
      insertHtmlAsMarkdown(view, payload.html ?? "", shift);
      return;
    case "text":
      insertPlain(view, payload.text ?? "");
      return;
    default:
      return; // empty
  }
}

/**
 * 图片分支：校验 → 路径守卫 → 落盘 → 插入。
 * 路径守卫仅在图片校验通过后触发——文本 / HTML 不落盘不弹保存；
 * 无效图片（ok=false）也不应先弹保存再报错。
 */
async function handleImagePayload(
  payload: ClipboardPayload,
  view: EditorView
): Promise<void> {
  const tr = get(t);
  if (!payload.ok) {
    toast$.set({
      id: Date.now(),
      msg: tr(
        payload.reason === "size"
          ? "toast.imageDroppedSize"
          : "toast.imageDroppedFormat"
      ),
    });
    return;
  }
  if (!payload.pendingId) {
    /* 后端约定 ok=true 必带 pendingId；缺失视为异常，走统一失败提示 */
    toast$.set({ id: Date.now(), msg: tr("toast.imageSaveFailed") });
    return;
  }
  /* 路径守卫：在落盘前介入；取消 → 干净退出（不产生任何文件） */
  if (!(await ensureDocSaved())) return;

  /* 落盘（可取消）：沿用归档命令的取消实现——超时阈值后展示进度框，
     用户点取消 → call.cancel() 取消后端写入（context.Context；暂存
     槽位保留，可重新粘贴）；取消后结果静默丢弃。 */
  const saveRef: { current: DialogProgressHandle | null } = { current: null };
  const saveAborted = { current: false };
  const saveCall = commitClipboardImage(payload.pendingId);
  const saveTimer = setTimeout(() => {
    if (saveRef.current) return;
    const handle = Dialog.progress({
      msg: tr("progress.savingImage"),
      buttons: [
        { value: "cancel", label: tr("common.cancel"), icon: "close" },
      ],
      minDurationMs: 500,
    });
    saveRef.current = handle;
    void handle.promise.then((value) => {
      if (value === "cancel") {
        saveAborted.current = true;
        saveCall.cancel();
      }
    });
  }, SAVE_PROGRESS_DELAY_MS);

  let img: ImportedImage | null = null;
  try {
    img = await saveCall;
  } catch {
    img = null; // 取消 / 落盘异常 → 统一走下方分支
  } finally {
    clearTimeout(saveTimer);
    const handle = saveRef.current;
    if (handle) {
      handle.finish();
      await handle.promise;
    }
  }

  if (saveAborted.current) return; // 用户取消：静默结束，无文件产生
  if (!img) {
    /* 槽位被覆盖 / TTL 过期 / 落盘失败 */
    toast$.set({ id: Date.now(), msg: tr("toast.imageSaveFailed") });
    return;
  }
  insertImages([img], view);
}

/** HTML 转换后替换当前选区（CM6 事务入撤销历史，可整体回退） */
function insertHtmlAsMarkdown(
  view: EditorView,
  html: string,
  stripStyles: boolean
): void {
  const md = htmlToMarkdown(html, stripStyles);
  if (!md) return;
  const sel = view.state.selection.main;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: md },
    userEvent: "input.paste",
  });
}

/** 纯文本替换当前选区（与默认粘贴同位语义；事务入撤销历史） */
function insertPlain(view: EditorView, text: string): void {
  if (!text) return;
  const sel = view.state.selection.main;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: text },
    userEvent: "input.paste",
  });
}