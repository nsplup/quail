/**
 * 插入图片共享入口（底栏按钮 / 拖拽 / 粘贴 三通道共用的前置校验与插入逻辑）。
 *
 * - 路径守卫（ensureDocSaved）：三个入口在执行任何业务前统一校验
 *   docState$.path——blank-open（未命名/无路径文档）时先弹 Dialog.confirm
 *   引导用户保存（保存 = 走另存为落盘），用户点击取消、或另存对话框被
 *   取消（仍无路径）时返回 false，调用方【中断当前行为】（不只是跳过
 *   图片：粘贴入口被取消时整个粘贴动作不继续）；
 * - 插入文本为内联式 `![alt](refDest)`：alt 与 destination 均由后端
 *   sanitize 后直接返回（见 ImportedImage.RefDest / Alt），前端零转义。
 */
import { get } from "svelte/store";
import { EditorView } from "@codemirror/view";
import { Dialog } from "./dialog";
import {
  docState$,
  editorApi$,
  saveFileAs,
  toast$,
  isDeletedInsertConfirmed,
  markDeletedInsertConfirmed,
} from "./stores";
import { importImageFiles, pickImagePaths, type ImportedImage } from "./bridge";
import { t } from "./i18n.svelte";

/**
 * 在光标处插入图片（内联式，块级语义与表格插入同通道）。
 *
 * - 省略 view（按钮 / 拖拽入口）：经主编辑器 EditorApi.insertBlock 落块；
 * - 传入 view（粘贴入口）：内联 Markdown 直接 dispatch 进收到粘贴事件的
 *   视图——主编辑器与单元格编辑器共用同一插入逻辑（幂等）。
 *
 * 语法为内联式 `![alt](path)`：不再生成引用定义块（无 `[ref]: path` 追加），
 * 每张图片一行（多图以换行分隔，形成独立块）。alt 与路径（refDest）均由
 * 后端统一 sanitize 构建（替换不安全字符为 '-'，不做包裹/转义），前端
 * 原样拼接即可。
 */
export function insertImages(
  images: ImportedImage[],
  view?: EditorView | null
): void {
  if (images.length === 0) return;
  const text = buildImageInsertText(images);
  if (!view) {
    get(editorApi$)?.insertBlock(text);
    return;
  }
  /* 块级语义：行中且有选区 → 选区替换；行首/空行 → 直接落块；
     行中无选区 → 前置换行新起块（与 EditorApi.insertBlock 同口径） */
  const sel = view.state.selection.main;
  const line = view.state.doc.lineAt(sel.from);
  const before =
    sel.from === sel.to && line.text.trim() !== "" && sel.from > line.from
      ? "\n"
      : "";
  const insertFrom = sel.from;
  const insertEnd = insertFrom + before.length + text.length;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: before + text },
    selection: { anchor: insertEnd },
    effects: EditorView.scrollIntoView(insertFrom + before.length, {
      y: "nearest",
      yMargin: 6,
    }),
    userEvent: "input.paste",
  });
  view.focus();
}


/** 插入文本构建：alt / destination 均为后端 sanitize 产物，原样拼接。
 *  （原前端 escapeAltText / escapeAngleDest 已删除——sanitize 由后端
 *  image_common.go 统一处理：不安全字符替换为安全字符，无包裹无转义。） */
function buildImageInsertText(images: ImportedImage[]): string {
  return images.map(({ alt, refDest }) => `![${alt}](${refDest})`).join("\n");
}

/**
 * 路径守卫：blank-open（无路径文档）时弹 Dialog.confirm 引导保存；
 * 有路径但文档已被外部删除（deleted 标记，见 file:deleted 事件）时弹
 * 三按钮确认——仍插入 / 另存为 / 取消（文案口径同 saveDeletedDoc）。
 * 返回 false = 用户取消引导 / 另存对话框被取消（仍无路径）——调用方
 * 必须中断当前行为（不只是跳过图片）。
 */
export async function ensureDocSaved(): Promise<boolean> {
  const st = get(docState$);
  if (st?.path) {
    if (!st.deleted) return true;
    return confirmDeletedDoc(st.path);
  }
  const tr = get(t);
  const res = await Dialog.confirm({
    msg: tr("image.saveFirst"),
    buttons: [
      { value: "save", label: tr("confirm.save"), icon: "floppy" },
      { value: "cancel", label: tr("common.cancel"), icon: "close" },
    ],
  });
  if (res !== "save") return false; // 用户取消：中断当前行为
  await saveFileAs("save"); // 无路径文档保存 = 另存为（stores.ts 统一入口）
  return !!get(docState$)?.path; // 另存对话框被取消 → 仍无路径 → 中断
}

/** 删除标记确认（三按钮）：仍插入 → 继续；另存为 → 落盘后复查路径；
 *  取消 → 中断当前行为。
 *
 *  「仍然插入」分支带会话级标记（stores.ts）：同一文档会话窗口内
 *  只提醒一次——确认过一次后，本轮会话内再次插入直接放行；标记在
 *  resetDocRuntime（文档会话重置）时复位。 */
async function confirmDeletedDoc(path: string): Promise<boolean> {
  const st = get(docState$);
  if (st?.deleted !== true) return true;
  // 本会话已确认过「仍然插入」→ 不再提醒，图片照常进入伴生资源目录
  if (isDeletedInsertConfirmed()) return true;
  const tr = get(t);
  const res = await Dialog.confirm({
    msg: tr("image.deletedInsert", { values: { path } }),
    buttons: [
      { value: "insert", label: tr("image.stillInsert"), icon: "image" },
      { value: "saveas", label: tr("common.saveAs"), icon: "floppy" },
      { value: "cancel", label: tr("common.cancel"), icon: "close" },
    ],
  });
  if (res === "insert") {
    markDeletedInsertConfirmed(); // 标记：本会话内不再重复提醒
    return true; // 仍插入：图片照常进入伴生资源目录
  }
  if (res === "saveas") {
    await saveFileAs("save"); // 另存为：新路径解除删除标记（stores.ts 统一入口）
    return get(docState$)?.deleted !== true; // 另存对话框被取消 → 状态无更新 → 中断
  }
  return false; // 取消：中断当前行为
}

/**
 * 插入图片按钮入口：路径守卫【最先执行】→ 弹系统多选对话框 → 导入+插入。
 * 守卫提前于选择器：blank-open / 已删除文档先完成引导，再打开文件选择。
 */
export async function pickAndInsertImages(): Promise<void> {
  if (!(await ensureDocSaved())) return;
  const paths = await pickImagePaths();
  if (!paths.length) return; // 用户取消选择
  await importAndInsert(paths);
}

/**
 * 导入图片文件并插入（拖拽入口；底栏按钮走 pickAndInsertImages）。
 * 后端逐个魔数校验（仅放行真实图片，SVG 与非图片静默跳过）；
 * 全部被丢弃时不插入也不提示（与拖拽静默丢弃口径一致）。
 * 返回 false = 被路径守卫中断（调用方不再继续后续流程）。
 */
export async function insertImageFiles(paths: string[]): Promise<boolean> {
  if (!(await ensureDocSaved())) return false;
  return importAndInsert(paths);
}

/** 导入 + 插入主体（守卫已在两个入口各自完成，不再重复校验） */
async function importAndInsert(paths: string[]): Promise<boolean> {
  let images: ImportedImage[];
  try {
    images = await importImageFiles(paths);
  } catch {
    toast$.set({ id: Date.now(), msg: get(t)("toast.imageImportFailed") });
    return true;
  }
  if (images.length > 0) insertImages(images);
  return true;
}
