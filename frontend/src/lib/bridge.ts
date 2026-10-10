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
import { Get as ConfigGet, ConfigExists, Save as ConfigSave } from "../../bindings/quail/configservice";
import { Events, Browser } from "@wailsio/runtime";

export interface QuailDocState {
  path: string;
  dir: string;
  name: string;
  content: string;
  encoding: string;
  size: number;
  modTime: number;
}

export interface QuailSaveResult {
  ok: boolean;
  conflict: boolean;
  path: string;
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

/* ---------------- FileService ---------------- */

/** 启动文档：后端按命令行参数提交，无路径则空文档（untitled），不弹对话框 */
export async function startupDoc(): Promise<QuailDocState | null> {
  return (await StartupDoc()) as unknown as QuailDocState | null;
}

/** 弹系统打开对话框并打开所选文档（取消返回 null） */
export async function openViaDialog(): Promise<QuailDocState | null> {
  const path = await PickOpen();
  if (!path) return null;
  return (await Open(path)) as unknown as QuailDocState;
}

/** 打开指定路径文档（拖拽打开：App 层 HTML5 DnD 解析路径 → 装载） */
export async function openDocument(path: string): Promise<QuailDocState | null> {
  return (await Open(path)) as unknown as QuailDocState;
}

/** 保存当前文档（force=true 跳过磁盘基线校验强制覆盖） */
export async function saveDocument(content: string, force = false): Promise<QuailSaveResult> {
  return (await Save(content, force)) as unknown as QuailSaveResult;
}

/** 保存到指定路径 */
export async function saveDocumentAs(path: string, content: string): Promise<QuailSaveResult> {
  return (await SaveAs(path, content)) as unknown as QuailSaveResult;
}

/** 弹系统另存对话框并保存（取消返回 null） */
export async function saveAsViaDialog(content: string): Promise<QuailSaveResult | null> {
  const path = await PickSave("untitled.md");
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

/** 配置文件是否已存在 */
export async function configExists(): Promise<boolean> {
  return await ConfigExists();
}

/** 保存配置（整包） */
export async function persistConfig(cfg: QuailConfig): Promise<void> {
  await ConfigSave(cfg);
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
