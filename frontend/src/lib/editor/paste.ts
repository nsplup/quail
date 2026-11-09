/**
 * 应用层粘贴处理器（App.svelte 启动时经 installAppPasteHandler 注册，
 * CM6 paste 域事件经 pasteHandler 注册表路由至此）。
 *
 * 分派优先级（逐层短路，未命中返回 false 走 CM6 默认粘贴）：
 *  1. image/*（clipboardData.items 中 kind=file 的图片项，通常仅一项）：
 *     a. mimetype 白名单校验——保留 png/jpeg/gif/webp/bmp/ico/avif，
 *        SVG 与其他未知格式丢弃（三入口统一丢 SVG）→ TOAST 通知；
 *     b. 数据大小校验——超过 20MB 丢弃 → TOAST 通知；
 *     c. 路径守卫——blank-open 先 Dialog.confirm 引导保存，取消 → 整个
 *        粘贴动作中断（不回落默认粘贴）；
 *     d. 字节交后端 SaveImageData 落盘伴生资源目录：300ms 内返回直接
 *        插入；超时进入长耗时状态 Dialog.progress（传入取消按钮、
 *        最小停留 500ms），拿到数据先 finish() 再等待弹窗收尾；用户点
 *        取消 → 整条操作链路被打断，后续返回结果被忽略（不插入）；
 *     e. 成功 → 定义引用格式插入（imageInsert.insertImages）。
 *  2. SHIFT 按下且含 text/html：HTML → markdown（丢弃样式，图文混排
 *     保留图片）——SHIFT 粘贴的语义是"无样式纯文本"，但图片必须存活，
 *     因此即使剪贴板同时带 text/plain 也走转换分支；
 *  3. text/plain：不做处理，返回 false 走默认行为；
 *  4. text/html（无 SHIFT、无纯文本）：HTML → markdown（保留 markdown
 *     语义映射），img 标签中的链接保持原样。
 */
import type { EditorView } from "@codemirror/view";
import { get } from "svelte/store";
import { registerPasteHandler } from "./pasteHandler";
import { htmlToMarkdown } from "./htmlToMarkdown";
import { ensureDocSaved, insertImages } from "../imageInsert";
import { Dialog, type DialogProgressHandle } from "../dialog";
import { toast$ } from "../stores";
import { saveImageData, type ImportedImage } from "../bridge";
import { t } from "../i18n.svelte";

/** 图片数据大小上限（需求口径：超过 20M 丢弃） */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** 后端保存响应等待阈值：超过则进入长耗时任务状态 */
const SAVE_TIMEOUT_MS = 300;

/** mimetype → 落盘扩展名（白名单口径；SVG 不在表内即被丢弃） */
const IMAGE_MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/x-icon": "ico",
  "image/avif": "avif",
};

/** 注册应用层粘贴处理器；返回注销函数 */
export function installAppPasteHandler(): () => void {
  return registerPasteHandler((event, view) => {
    const cmView = view as EditorView | null;
    if (!cmView) return false;
    const dt = event.clipboardData;
    if (!dt) return false;

    /* 1. image/*：整段转交图片粘贴链路（异步业务 void 化，同步返回 true） */
    const items = Array.from(dt.items ?? []);
    console.log(dt.types)
    const imageItem = [...items]
      .reverse()
      .find((it) => it.kind === "file" && it.type.startsWith("image/"));
    if (imageItem) {
      event.preventDefault();
      void handleImagePaste(imageItem);
      return true;
    }

    const html = dt.getData("text/html");
    const plain = dt.getData("text/plain");

    /* 2. SHIFT + text/html：丢弃样式转换（图文混排保留图片） */
    if (event.shiftKey && html) {
      event.preventDefault();
      insertHtmlAsMarkdown(cmView, html, true);
      return true;
    }

    /* 3. text/html（无纯文本）：保留语义映射的 markdown 转换 */
    if (html) {
      event.preventDefault();
      insertHtmlAsMarkdown(cmView, html, false);
      return true;
    }

    /* 4. text/plain：不做处理，默认行为 */
    if (plain) return false;
    
    return false;
  });
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
  });
}

/** 图片粘贴链路（image/* 分支主体；调用方已 preventDefault） */
async function handleImagePaste(item: DataTransferItem): Promise<void> {
  const tr = get(t);

  /* a. mimetype 校验：白名单保留常见格式，SVG 与未知格式丢弃 */
  const mime = (item.type || "").toLowerCase();
  if (!IMAGE_MIME_EXT[mime]) {
    toast$.set({ id: Date.now(), msg: tr("toast.imageDroppedFormat") });
    return;
  }

  const file = item.getAsFile();
  if (!file) return;

  /* b. 数据大小校验：超过 20MB 丢弃 */
  if (file.size > MAX_IMAGE_BYTES) {
    toast$.set({ id: Date.now(), msg: tr("toast.imageDroppedSize") });
    return;
  }

  /* c. 路径守卫：取消引导 → 中断整个粘贴（不回落默认粘贴） */
  if (!(await ensureDocSaved())) return;

  const bytes = new Uint8Array(await file.arrayBuffer());

  /* d. 后端落盘：300ms 阈值 → Dialog.progress（取消按钮 + 最小停留 500ms） */
  let progress: DialogProgressHandle | null = null;
  let aborted = false;
  const timer = setTimeout(() => {
    if (progress) return;
    progress = Dialog.progress({
      msg: tr("progress.savingImage"),
      buttons: [
        { value: "cancel", label: tr("common.cancel"), icon: "close" },
      ],
      minDurationMs: 500,
    });
    void progress.promise.then((value) => {
      if (value === "cancel") aborted = true; // 操作链路被打断
    });
  }, SAVE_TIMEOUT_MS);

  let saved: ImportedImage | null = null;
  try {
    saved = await saveImageData(bytes);
  } catch {
    toast$.set({ id: Date.now(), msg: tr("toast.imageSaveFailed") });
    return;
  } finally {
    clearTimeout(timer);
    if (progress) {
      progress.finish(); // 最小停留计时起算点，500ms 内不关闭
      await progress.promise; // 等待弹窗真正收尾再继续
    }
  }

  /* e. 取消打断：丢弃已保存结果，不插入 */
  if (aborted) return;
  if (saved) insertImages([saved]);
}
