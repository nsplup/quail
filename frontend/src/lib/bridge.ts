/**
 * Wails 桥接层（quail 桌面壳专用）。
 *
 * - bindings 一律静态 import：vite 构建期解析打包，不依赖运行时相对路径；
 *   `wails3 generate bindings` 重新生成后如方法/路径变化只需调整 import；
 * - 仅面向 Wails 环境（不再做浏览器降级判断）。
 */

import { AppService, FileService, ConfigService } from "@bindings";
import { Events, Browser, Dialogs } from "@wailsio/runtime";
import { get } from "svelte/store";
import { t } from "./i18n.svelte";

const {
  Ready,
  RequestClose,
  ConfirmQuit,
  SetTitle,
  CloseWindow,
  NewInstance,
} = AppService;

const {
  ImageFilePath,
  ImageSaveFile,
  Open,
  SaveAs,
  Save,
  CloseDoc,
  StartupFiles,
  OpenFileWithExternal,
  ClassifyFiles,
  ImportImageFiles,
  ReadClipboard,
  CommitClipboardImage,
  ArchiveImages,
} = FileService;

const { Get: ConfigGet, SaveFields: ConfigSaveFields } = ConfigService;

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

/** 窗口标题与文档名同步 */
export async function setTitle(title: string): Promise<void> {
  await SetTitle(title);
}

/** 发起关闭请求（后端 emit close:request → 前端确认） */
export async function requestClose(): Promise<void> {
  await RequestClose();
}

/** 外部链接打开：仅放行合法的 http/https 链接交由后端转发（runtime 桥接 →
 *  Go 调用系统默认浏览器，与图片 /__imgproxy 同为后端转发模式）。
 *  其他协议（file: / javascript: / data: 等）一律不转发；可能合法但不携带
 *  protocol 的链接（如 "example.com/a"、协议相对的 "//example.com/a"）按
 *  https 补全后再次校验，仍非法则静默忽略，不调用后端。 */
export async function openExternal(url: string): Promise<void> {
  const target = normalizeExternalUrl(url);
  if (!target) return;
  await Browser.OpenURL(target);
}

/** 外链白名单校验与归一：
 *  - 携带合法 http/https 协议且主机名非空 → 原样放行；
 *  - 显式携带其他 scheme（file: / javascript: / mailto: / ftp: 等一律拒绝，
 *    含 "http://" 这类缺主机名的残缺链接）→ 返回 null，不再补全；
 *  - 未携带 protocol → 补全 https（协议相对 //host 同样归一到 https）后
 *    复验，合法返回补全结果（转发的即校验通过的内容，不回传原始串）；
 *  - 其余（空串 / 非法 URL / 无主机名）返回 null。 */
function normalizeExternalUrl(raw: string): string | null {
  const input = (raw ?? "").trim();
  if (!input) return null;
  if (isHttpUrl(input)) return input;
  // 已显式携带 scheme：非 http/https（或主机名缺失）直接拒绝，不补全
  if (/^[a-z][a-z0-9+.-]*:/i.test(input)) return null;
  const candidate = input.startsWith("//") ? `https:${input}` : `https://${input}`;
  return isHttpUrl(candidate) ? candidate : null;
}

/** 合法 http/https 判定：URL 可解析、协议为 http/https、主机名非空 */
function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname !== "";
  } catch {
    return false;
  }
}

/** Ctrl+Q 退出：等同窗口关闭操作（无脏状态直接退出；脏状态走守卫 confirm） */
export async function closeWindow(): Promise<void> {
  await CloseWindow();
}

/** 拉起新实例（Ctrl+N）：path 为空以未命名空文档启动，非空由新实例装载该文件 */
export async function newInstance(path = ""): Promise<void> {
  await NewInstance(path);
}

/** 用系统默认程序打开本地文件（wails runtime Browser.OpenFile，与
 *  openExternal 同为后端/运行时转发模式）。图片右键菜单「使用外部程序
 *  打开」用：path 为后端 ImageFilePath 解析出的代理缓存文件绝对路径。 */
export async function openFileWithSystem(path: string): Promise<void> {
  await OpenFileWithExternal(path);
}

/* ---------------- FileService ---------------- */

export interface QuailStartupFiles {
  doc: QuailDocState;
  extraFiles: string[];
}

export async function startupFiles(): Promise<QuailStartupFiles> {
  return (await StartupFiles()) as unknown as QuailStartupFiles;
}

export async function pickOpenPaths(): Promise<string[]> {
  const picked = await Dialogs.OpenFile({
    Title: get(t)("dialogs.open"),
    AllowsMultipleSelection: true,
    Filters: [
      { DisplayName: "Markdown", Pattern: "*.md;*.markdown" },
      { DisplayName: "Text", Pattern: "*.txt" },
    ],
  });
  const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
  return paths.filter((p) => !!p);
}

export async function openDocument(path: string): Promise<QuailDocState | null> {
  return (await Open(path)) as unknown as QuailDocState | null;
}

export async function saveDocument(content: string, force = false): Promise<QuailSaveResult> {
  return (await Save(content, force)) as unknown as QuailSaveResult;
}

export async function saveDocumentAs(path: string, content: string): Promise<QuailSaveResult> {
  return (await SaveAs(path, content)) as unknown as QuailSaveResult;
}

export async function saveAsViaDialog(
  content: string,
  defaultName = "untitled.md",
  kind: "save" | "saveAs" = "saveAs"
): Promise<QuailSaveResult | null> {
  const path = await Dialogs.SaveFile({
    Title: get(t)(kind === "save" ? "dialogs.save" : "dialogs.saveAs"),
    Filename: defaultName || "untitled.md",
    Filters: [{ DisplayName: "Markdown", Pattern: "*.md;*.markdown" }],
  });
  if (!path) return null;
  return (await SaveAs(path, content)) as unknown as QuailSaveResult;
}

/** 系统保存对话框：只取输出路径不落盘（归档图片命令先拿伴生资源目录
 *  的宿主路径）。titleKey 透传对话框标题语义（保存 / 另存为）。 */
export async function pickSavePath(
  defaultName = "untitled.md",
  titleKey: "save" | "saveAs" = "save"
): Promise<string | null> {
  const path = await Dialogs.SaveFile({
    Title: get(t)(titleKey === "save" ? "dialogs.save" : "dialogs.saveAs"),
    Filename: defaultName || "untitled.md",
    Filters: [{ DisplayName: "Markdown", Pattern: "*.md;*.markdown" }],
  });
  return path || null;
}

/* ---------------- 图片归档（命令面板「归档图片文件到伴生资源目录」） ---------------- */

/**
 * Wails 绑定调用的可取消 Promise：`cancel()` 取消后端绑定的
 * context.Context（Wails v3 官方取消通道），长耗时任务可被打断。
 */
export type CancellablePromise<T> = Promise<T> & { cancel(): void };

export interface QuailArchiveResult {
  ok: boolean;
  path: string;
  /** 发现的可归档图片引用数（按解析结果去重） */
  found: number;
  /** 成功复制/下载到伴生资源目录的数量 */
  archived: number;
  /** 读取/下载/校验失败的数量（对应引用保持原样不动） */
  failed: number;
  /** 是否已将替换后的内容落盘（无引用 / 全部失败 / 内容无变化时不写） */
  written: boolean;
  /** 用户经取消按钮中断：已归档部分保留，内容不替换不落盘 */
  cancelled?: boolean;
}

/** 归档文档内容中的图片引用到目标路径的伴生资源目录：后端解析三种引用
 *  （内联式 / 引用式定义 / HTML img）、本地复制远程下载、替换引用路径、
 *  落盘文档。写入【不携带自身写入抑制】——目标为当前文档时 watch 放行
 *  file:changed 广播，前端由此感知文档被修改；文档会话状态不变。
 *  返回可取消 Promise：调用方据 cancel() 打断后端归档。 */
export function archiveImagesToPath(
  content: string,
  path: string
): CancellablePromise<QuailArchiveResult> {
  return ArchiveImages(content, path) as unknown as CancellablePromise<QuailArchiveResult>;
}

export async function confirmQuit(): Promise<void> {
  await ConfirmQuit();
}

/* ---------------- 图片右键菜单（imgproxy 资源操作） ---------------- */

export async function imageFilePath(proxySrc: string): Promise<string | null> {
  const p = (await ImageFilePath(proxySrc)) as unknown as string;
  return p || null;
}

export async function saveImageViaDialog(
  proxySrc: string,
  defaultName: string
): Promise<string | null> {
  const path = await Dialogs.SaveFile({
    Title: get(t)("dialogs.saveAs"),
    Filename: defaultName || "image.png",
    Filters: [
      {
        DisplayName: "Image",
        Pattern: "*.png;*.jpg;*.jpeg;*.gif;*.webp;*.svg;*.bmp;*.ico;*.avif",
      },
    ],
  });
  if (!path) return null;
  await ImageSaveFile(proxySrc, path);
  return path;
}

export async function closeDocument(): Promise<void> {
  await CloseDoc();
}

/* ---------------- 插入图片（按钮 / 拖拽 / 粘贴 三入口共用后端通道） ---------------- */

export type FileKindInfo = { path: string; kind: "image" | "text" | "other" };

export type ImportedImage = {
  relPath: string;
  name: string;
  /** markdown destination（后端 markdownDest 构建，无需前端转义/包裹） */
  refDest: string;
  /** sanitize 后的 alt 文本（后端 sanitizeAltText 构建） */
  alt: string;
};

export async function classifyFiles(paths: string[]): Promise<FileKindInfo[]> {
  return (await ClassifyFiles(paths)) as unknown as FileKindInfo[];
}

export async function importImageFiles(paths: string[]): Promise<ImportedImage[]> {
  return (await ImportImageFiles(paths)) as unknown as ImportedImage[];
}

/* ---------------- 粘贴链路剪贴板（后端读取，前端不碰 ClipboardEvent 数据） ---------------- */

/** ReadClipboard 返回的统一 payload：
 *  - kind=image & ok=true：携带 pendingId，需路径守卫通过后调用
 *    commitClipboardImage 落盘；
 *  - kind=image & ok=false：reason 为 format（SVG/非图片）或 size（超 20MB）；
 *  - kind=html：html（text/html）与 text（text/plain）同时携带；
 *  - kind=text：仅纯文本；kind=empty：无可消费内容。 */
export type ClipboardPayload = {
  kind: "image" | "html" | "text" | "empty";
  ok: boolean;
  pendingId?: number;
  html?: string;
  text?: string;
  reason?: "format" | "size" | "";
};

/** 粘贴链路：读取系统剪贴板（图片只做校验 + 内存暂存，不落盘）。
 *  返回可取消 Promise：调用方据 cancel() 打断后端读取。 */
export function readClipboard(): CancellablePromise<ClipboardPayload> {
  return ReadClipboard() as unknown as CancellablePromise<ClipboardPayload>;
}

/** 落盘 readClipboard 暂存的粘贴图片（路径守卫通过后调用）。
 *  返回可取消 Promise：调用方据 cancel() 打断后端写入（暂存槽位保留）。
 *  resolve null = 槽位被后续粘贴覆盖 / TTL 过期；reject = 取消或失败。 */
export function commitClipboardImage(
  pendingId: number
): CancellablePromise<ImportedImage | null> {
  return CommitClipboardImage(pendingId) as unknown as CancellablePromise<ImportedImage | null>;
}

/** 弹系统打开对话框多选图片（插入图片按钮用，取消返回空数组） */
export async function pickImagePaths(): Promise<string[]> {
  const picked = await Dialogs.OpenFile({
    Title: get(t)("image.pickTitle"),
    AllowsMultipleSelection: true,
    Filters: [
      {
        DisplayName: "Image",
        Pattern: "*.png;*.jpg;*.jpeg;*.gif;*.webp;*.bmp;*.ico;*.avif",
      },
    ],
  });
  const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
  return paths.filter((p) => !!p);
}

/* ---------------- ConfigService ---------------- */

export async function loadConfig(): Promise<QuailConfig | null> {
  return (await ConfigGet()) as unknown as QuailConfig;
}

export async function persistConfigFields(fields: Record<string, unknown>): Promise<void> {
  await ConfigSaveFields(fields);
}

/* ---------------- 事件 ---------------- */

export type FileEventName = "file:changed" | "file:deleted" | "file:dropped";
export type ConfigEventName = "config:changed";
export type CloseEventName = "close:request";

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