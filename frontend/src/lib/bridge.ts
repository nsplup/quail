/**
 * Wails 桥接层（quail 桌面壳专用）。
 *
 * - bindings 一律静态 import：vite 构建期解析打包，不依赖运行时相对路径；
 *   `wails3 generate bindings` 重新生成后如方法/路径变化只需调整 import；
 * - 仅面向 Wails 环境（不再做浏览器降级判断）。
 */

import {
  Ready,
  HasUnsavedChanges,
  RequestClose,
  ConfirmQuit,
  SetTitle,
  CloseWindow,
  NewInstance,
} from "../../bindings/quail/appservice";
import {
  PickOpen,
  PickSave,
  Open,
  SaveAs,
  Save,
  CloseDoc,
  StartupDoc,
} from "../../bindings/quail/fileservice";
import { Get as ConfigGet, SaveFields as ConfigSaveFields } from "../../bindings/quail/configservice";
import { Events, Browser } from "@wailsio/runtime";

export interface QuailDocState {
  path: string;
  dir: string;
  name: string;
  content: string;
  encoding: string;
  size: number;
  modTime: number;
  /** 文件已被外部移动/删除（file:deleted 事件置位；保存路由到确认重建流程） */
  deleted?: boolean;
}

export interface QuailSaveResult {
  ok: boolean;
  conflict: boolean;
  path: string;
  /** dir/name 另存成功时由后端按平台规范填充（Windows 反斜杠路径解析） */
  dir?: string;
  name?: string;
}

export interface QuailConfig {
  mode: string;
  theme: string;
  locale: string;
  indent: string;
  countMode: string;
  fontEditor: string;
  fontPreview: string;
  fontSizeEditor: number;
  fontSizePreview: number;
}

/* ---------------- AppService ---------------- */

/** 首帧就绪：显示窗口 */
export async function ready(): Promise<void> {
  await Ready();
}

/** 上报脏状态 */
export async function reportDirty(dirty: boolean): Promise<void> {
  await HasUnsavedChanges(dirty);
}

/** 窗口标题与文档名同步 */
export async function setTitle(title: string): Promise<void> {
  await SetTitle(title);
}

/** 发起关闭请求（后端 emit close:request → 前端确认） */
export async function requestClose(): Promise<void> {
  await RequestClose();
}

/** 外部链接打开：runtime 桥接 → Go 调用系统默认浏览器（与图片 /__imgproxy 同为后端转发模式） */
export async function openExternal(url: string): Promise<void> {
  await Browser.OpenURL(url);
}

/** Ctrl+Q 退出：等同窗口关闭操作（无脏状态直接退出；脏状态走守卫 confirm） */
export async function closeWindow(): Promise<void> {
  await CloseWindow();
}

/** 拉起新实例（Ctrl+N）：path 为空以未命名空文档启动，非空由新实例装载该文件 */
export async function newInstance(path = ""): Promise<void> {
  await NewInstance(path);
}

/* ---------------- FileService ---------------- */

/** 启动文档：后端按命令行参数提交，无路径则空文档（untitled），不弹对话框 */
export async function startupDoc(): Promise<QuailDocState | null> {
  return (await StartupDoc()) as unknown as QuailDocState | null;
}

/** 弹系统打开对话框，仅返回所选路径（取消返回 null） */
export async function pickOpenPath(): Promise<string | null> {
  const path = await PickOpen();
  return path || null;
}

/**
 * 原地打开指定路径文档（当前实例为未命名空白文档且无编辑记录时的打开通道）；
 * 二进制文件返回 null（静默丢弃，与启动装载口径一致）。
 */
export async function openDocument(path: string): Promise<QuailDocState | null> {
  return (await Open(path)) as unknown as QuailDocState | null;
}

/** 保存当前文档（force=true 跳过磁盘基线校验强制覆盖） */
export async function saveDocument(content: string, force = false): Promise<QuailSaveResult> {
  return (await Save(content, force)) as unknown as QuailSaveResult;
}

/** 保存到指定路径 */
export async function saveDocumentAs(path: string, content: string): Promise<QuailSaveResult> {
  return (await SaveAs(path, content)) as unknown as QuailSaveResult;
}

/** 弹系统另存对话框并保存（取消返回 null；defaultName 由调用方按界面语言传入） */
export async function saveAsViaDialog(content: string, defaultName = "untitled.md"): Promise<QuailSaveResult | null> {
  const path = await PickSave(defaultName);
  if (!path) return null;
  return (await SaveAs(path, content)) as unknown as QuailSaveResult;
}

/** 确认退出（close:request 确认后调用） */
export async function confirmQuit(): Promise<void> {
  await ConfirmQuit();
}

/** 关闭当前文档 */
export async function closeDocument(): Promise<void> {
  await CloseDoc();
}

/* ---------------- ConfigService ---------------- */

/** 读取配置 */
export async function loadConfig(): Promise<QuailConfig | null> {
  return (await ConfigGet()) as unknown as QuailConfig;
}

/** 增量保存配置：仅提交脏字段，后端与磁盘最新配置按字段合并（多窗口互不覆盖） */
export async function persistConfigFields(fields: Record<string, unknown>): Promise<void> {
  await ConfigSaveFields(fields);
}

/* ---------------- 事件 ---------------- */

export type FileEventName = "file:changed" | "file:deleted" | "file:dropped";
export type ConfigEventName = "config:changed";
export type CloseEventName = "close:request";

/** 订阅后端事件（返回取消函数） */
export function onBackendEvent(
  name: FileEventName | ConfigEventName | CloseEventName,
  handler: (data: any) => void
): () => void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const off = (Events as any).On(name, (ev: any) => handler(ev?.data));
  return () => {
    try {
      if (typeof off === "function") off();
    } catch {
      /* ignore */
    }
  };
}
