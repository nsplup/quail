/**
 * 应用层粘贴处理器（App.svelte 启动时经 installAppPasteHandler 注册，
 * CM6 侧的 Mod-v keydown 拦截与右键菜单 pasteFromMenu 经 pasteHandler
 * 注册表 / pasteFromMenu 路由至此；主编辑器与单元格编辑器共用同一处理
 * 器，插入一律作用于触发粘贴的视图）。
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
 *     - kind=html：plain（菜单"粘贴为纯文本"）→ 直接插入自带 text/plain；
 *       否则经 htmlToMarkdown 转换（含可转换检测，无可转换标签回退纯
 *       文本）——均作用于传入的 cmView；
 *     - kind=text：纯文本替换当前选区；
 *     - kind=empty：无消费内容，动作结束。
 *  2. 后端读取 / 落盘超阈值进入 Dialog.progress（取消按钮 + 最小停留
 *     500ms）；用户点取消 → call.cancel() 取消后端 context.Context，
 *     整条操作链路被打断（取消后结果静默丢弃；落盘取消时暂存槽位保留）。
 *     落盘段仅在实际超阈值时弹框（快路径无感）。
 *
 * 粘贴入口：不再是 paste 事件——快捷键层（codemirrorSetup 的 Mod-v
 * keydown）与右键菜单（pasteFromMenu）显式触发本链路。SHIFT+Mod-v 直接
 * 走原生默认粘贴（快捷键层放行，不进入本模块）；"粘贴为纯文本"由右键
 * 菜单承担（plain 模式，html payload 直接取自带 text/plain 插入）。
 *
 * HTML 分支：先经 htmlToMarkdown 的可转换检测——剪贴板 HTML 完全不含
 * 可映射 Markdown 语义（标准 + GFM）的标签时跳过转换输出，回退插入
 * 纯文本（payload.text），避免"什么都不发生"。
 */
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
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

/** 注册应用层粘贴处理器；返回注销函数 */
export function installAppPasteHandler(): () => void {
  return registerPasteHandler((event, view) => {
    const cmView = view as EditorView | null;
    if (!cmView) return false;
    /* 快捷键层已 preventDefault（原生 paste 事件不再触发）；此处幂等兜底 */
    event.preventDefault();
    void handlePaste(cmView, false);
    return true;
  });
}

/** 右键菜单粘贴入口：复用 Mod-v 同一条链路（plain=true → 粘贴为纯文本） */
export function pasteFromMenu(view: EditorView, plain = false): void {
  void handlePaste(view, plain);
}

/** 粘贴链路主体：后端读取 → 按 payload 分派（调用方已 preventDefault） */
async function handlePaste(view: EditorView, plain: boolean): Promise<void> {
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
      insertHtmlPayload(view, payload.html ?? "", payload.text ?? "", plain);
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

/**
 * 粘贴插入的公共原语：以给定文本替换主选区，光标落到插入文本末尾并
 * 滚动可见（纯文本 / HTML→Markdown 转换结果共用）。
 *
 * CM6 默认的选区映射会把旧选区锚点留在插入文本起点附近，导致"粘贴后
 * 光标不在末尾"；此处显式设置 selection，并用 scrollIntoView 保证光标
 * 可见（yMargin 6px 避免贴边）。userEvent 固定为 input.paste，保持撤销
 * 历史与命令识别的语义。
 *
 * 空文本守卫由调用方负责（insertPlain / insertHtmlPayload 各自保留），
 * 本函数不做空内容短路——空串的 changes 等价于纯删除选区。
 */
function replaceSelectionAndMoveCursor(view: EditorView, text: string): void {
  const sel = view.state.selection.main;
  const pos = sel.from + text.length;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: text },
    selection: EditorSelection.cursor(pos),
    effects: EditorView.scrollIntoView(pos, { y: "nearest", yMargin: 6 }),
    userEvent: "input.paste",
  });
}

/**
 * HTML payload 插入：
 * - plain（菜单"粘贴为纯文本"）：直接插入剪贴板自带的 text/plain；
 * - 否则经 htmlToMarkdown 转换（含可转换检测）；无可转换标签时跳过
 *   转换输出，回退插入纯文本，避免"什么都不发生"；
 * - 两条插入路径均走 replaceSelectionAndMoveCursor：光标落到插入文本
 *   末尾并滚动可见。
 */
function insertHtmlPayload(
  view: EditorView,
  html: string,
  plainText: string,
  plain: boolean
): void {
  if (plain) {
    insertPlain(view, plainText);
    return;
  }
  const res = htmlToMarkdown(html);
  if (!res.convertible) {
    /* 无任何可映射 Markdown 语义的标签：跳过输出管线，回退纯文本 */
    insertPlain(view, plainText);
    return;
  }
  const md = res.markdown;
  if (!md) return;
  replaceSelectionAndMoveCursor(view, md);
}

/** 纯文本替换当前选区（与默认粘贴同位语义；事务入撤销历史） */
function insertPlain(view: EditorView, text: string): void {
  if (!text) return;
  replaceSelectionAndMoveCursor(view, text);
}