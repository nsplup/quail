/**
 * 归档图片文件到伴生资源目录（命令面板命令的业务流程）。
 *
 * - 输出路径：先经系统保存对话框（title = 保存）拿到目标文档路径，本步
 *   不落盘（pickSavePath 只取路径）；
 * - 进度：后端归档（下载远程 / 复制本地 + 替换引用路径 + 落盘）期间展示
 *   Dialog.progress（不可交互关闭），结束后至少停留 1s 再放行；
 * - 通知：落盘结果由前端发出 TOAST（按 无引用 / 全部成功 / 部分失败 /
 *   全部失败 四种口径），当前文档会话状态不变——后端写入不携带自身写入
 *   抑制，覆盖当前文档时 file:changed 事件照常到达（横幅流程接管）；
 * - 内容：编辑器持有的缓存区（doc$）整体传给后端。
 */
import { get } from "svelte/store";
import { doc$, docState$, toast$ } from "./stores";
import { archiveImagesToPath, pickSavePath } from "./bridge";
import { Dialog } from "./dialog";
import { t } from "./i18n.svelte";

/** 归档进度框最小停留时长（要求 ≥1s，结束后才放行 TOAST） */
const ARCHIVE_PROGRESS_MIN_MS = 1000;

export async function archiveImagesToCompanion(): Promise<void> {
  const tr = get(t);
  // 1) 保存对话框（title 为保存）拿输出路径；取消则静默结束
  const path = await pickSavePath(
    get(docState$)?.name || `${tr("doc.untitled")}.md`,
    "save"
  );
  if (!path) return;

  // 2) 进度框：至少停留 1s；期间遮罩不可交互关闭
  const handle = Dialog.progress({
    msg: tr("archive.progress"),
    minDurationMs: ARCHIVE_PROGRESS_MIN_MS,
  });
  let failed = false;
  let res: Awaited<ReturnType<typeof archiveImagesToPath>> | null = null;
  try {
    res = await archiveImagesToPath(get(doc$), path);
  } catch {
    failed = true;
  }
  handle.finish();
  await handle.promise; // 等 progress 达到最小停留时长关闭后再通知

  // 3) TOAST 通知（当前文档会话状态不变：doc$ / docState$ 均不动，
  //    覆盖当前文档时的变更感知由 file:changed 横幅流程接管）
  if (failed || !res?.ok) {
    toast$.set({ id: Date.now(), msg: tr("toast.archiveFailed") });
    return;
  }
  if (res.found === 0) {
    toast$.set({ id: Date.now(), msg: tr("toast.archiveNone") });
    return;
  }
  if (res.failed === 0) {
    toast$.set({
      id: Date.now(),
      msg: tr("toast.archiveDone", { values: { n: res.archived } }),
    });
    return;
  }
  if (res.archived > 0) {
    toast$.set({
      id: Date.now(),
      msg: tr("toast.archivePartial", {
        values: { n: res.archived, m: res.failed },
      }),
    });
    return;
  }
  toast$.set({
    id: Date.now(),
    msg: tr("toast.archiveAllFailed", { values: { n: res.found } }),
  });
}
