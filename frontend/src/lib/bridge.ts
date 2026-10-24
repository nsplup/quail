/**
 * Wails 桥接层（quail 桌面壳专用）。
 *
 * - bindings 一律静态 import：vite 构建期解析打包，不依赖运行时相对路径；
 *   `wails3 generate bindings` 重新生成后如方法/路径变化只需调整 import；
 * - 仅面向 Wails 环境（不再做浏览器降级判断）。
 */

import { AppService, FileService, ConfigService } from "@bindings";
import { Events, Browser } from "@wailsio/runtime";
import { withDialogMask } from "./confirm";

const {
  Ready,
  HasUnsavedChanges,
  RequestClose,
  ConfirmQuit,
  SetTitle,
  CloseWindow,
  NewInstance,
} = AppService;

const {
  PickOpen,
  PickSave,
  PickImageSave,
  ImageFilePath,
  ImageSaveFile,
  Open,
  SaveAs,
  Save,
  CloseDoc,
  StartupFiles,
  OpenFileWithExternal,
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

/** 启动文件列表装载结果：首个文件装载为当前实例文档，其余文件路径由
 *  前端逐个拉起新实例装载（每文件一窗口）。 */
export interface QuailStartupFiles {
  /** 首个有效文件装载的文档状态（无有效路径 → 空文档，Name 为空串） */
  doc: QuailDocState;
  /** 命令行中除首个文档外的其余有效文件路径（已按出现顺序排列） */
  extraFiles: string[];
}

/** 启动文件列表：后端按命令行参数装载首个文件并返回其余文件路径，
 * 无路径则空文档 + 空列表（untitled），不弹对话框 */
export async function startupFiles(): Promise<QuailStartupFiles> {
  return (await StartupFiles()) as unknown as QuailStartupFiles;
}

/** 弹系统打开对话框（可多选），返回所选路径列表（取消返回空数组）。
 * 弹窗期间显示空白遮罩（只有遮罩无面板，不可点击关闭），
 * 等待弹窗得到结果后遮罩关闭。 */
export async function pickOpenPaths(): Promise<string[]> {
  const paths = await withDialogMask<string[]>(
    async () => (await PickOpen()) ?? []
  );
  return paths.filter((p) => !!p);
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

/** 弹系统另存对话框并保存（取消返回 null；defaultName 由调用方按界面语言传入）。
 * 系统弹窗存续期间显示空白遮罩（只有遮罩无面板，不可点击关闭），
 * 等待弹窗得到结果后遮罩关闭。 */
export async function saveAsViaDialog(
  content: string,
  defaultName = "untitled.md"
): Promise<QuailSaveResult | null> {
  const path = await withDialogMask<string | null>(
    async () => await PickSave(defaultName)
  );
  if (!path) return null;
  return (await SaveAs(path, content)) as unknown as QuailSaveResult;
}

/** 确认退出（close:request 确认后调用） */
export async function confirmQuit(): Promise<void> {
  await ConfirmQuit();
}

/* ---------------- 图片右键菜单（imgproxy 资源操作） ---------------- */

/**
 * 解析 imgproxy 代理 URL 为磁盘文件路径（图片右键菜单「使用外部程序打开」用）。
 * local：文档目录白名单内资源的目标绝对路径；remote：代理缓存文件路径
 * （未命中缓存时后端先下载缓存再返回，确保路径在文件系统上可用）。
 * 返回 null 表示解析失败（越权 / 不存在 / 下载失败等，由调用方提示）。
 */
export async function imageFilePath(proxySrc: string): Promise<string | null> {
  const p = (await ImageFilePath(proxySrc)) as unknown as string;
  return p || null;
}

/**
 * 图片另存为：弹系统「保存图片」对话框（取消返回 null），选定路径后由
 * 后端读取源文件（本地资源 / 远程缓存）原子写入，字节不经前端往返。
 * 弹窗期间与文档另存为同口径显示空白遮罩（withDialogMask）。
 */
export async function saveImageViaDialog(
  proxySrc: string,
  defaultName: string
): Promise<string | null> {
  const path = await withDialogMask<string | null>(
    async () => await PickImageSave(defaultName)
  );
  if (!path) return null;
  await ImageSaveFile(proxySrc, path);
  return path;
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
