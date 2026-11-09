/**
 * 插入图片共享入口（底栏按钮 / 拖拽 / 粘贴 三通道共用的前置校验与插入逻辑）。
 *
 * - 路径守卫（ensureDocSaved）：三个入口在执行任何业务前统一校验
 *   docState$.path——blank-open（未命名/无路径文档）时先弹 Dialog.confirm
 *   引导用户保存（保存 = 走另存为落盘），用户点击取消、或另存对话框被
 *   取消（仍无路径）时返回 false，调用方【中断当前行为】（不只是跳过
 *   图片：粘贴入口被取消时整个粘贴动作不继续）；
 * - 引用式插入：插入文本使用定义引用格式（伪代码
 *   `insert([...pics, def.join('\n')].join('\n\n'))`）——引用行
 *   `![alt][id]` 与定义块 `[id]: <relPath>` 一起经 CM6 insertBlock 作为
 *   块级内容落在光标处（预览管线经 reference-store 收集后渲染）；
 * - 引用标识符（normalizeImageRefId）：按 micromark normalizeIdentifier
 *   口径（折叠空白为单空格、trim、小写）生成，批内查重 + 追加 -2/-3…
 *   后缀；与现有文档中的引用定义撞名时同样追加后缀（CommonMark 首定义
 *   优先，撞名会让新图引用解析到旧定义）。
 */
import { get } from "svelte/store";
import { Dialog } from "./dialog";
import { doc$, docState$, editorApi$, saveFileAs, toast$ } from "./stores";
import { importImageFiles, type ImportedImage } from "./bridge";
import { buildImageInsertText } from "./markdown/image-ref";
import { t } from "./i18n.svelte";

/** 在光标处插入图片（引用式，块级语义与表格插入同通道） */
export function insertImages(images: ImportedImage[]): void {
  const text = buildImageInsertText(images, get(doc$));
  get(editorApi$)?.insertBlock(text);
}

/**
 * 路径守卫：blank-open（无路径文档）时弹 Dialog.confirm 引导保存。
 * 返回 false = 用户取消引导 / 另存对话框被取消（仍无路径）——调用方
 * 必须中断当前行为（不只是跳过图片）。
 */
export async function ensureDocSaved(): Promise<boolean> {
  const st = get(docState$);
  if (st?.path) return true;
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

/**
 * 导入图片文件并插入（底栏按钮多选 / 拖拽 共用）。
 * 后端逐个魔数校验（仅放行真实图片，SVG 与非图片静默跳过）；
 * 全部被丢弃时不插入也不提示（与拖拽静默丢弃口径一致）。
 * 返回 false = 被路径守卫中断（调用方不再继续后续流程）。
 */
export async function insertImageFiles(paths: string[]): Promise<boolean> {
  if (!(await ensureDocSaved())) return false;
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
