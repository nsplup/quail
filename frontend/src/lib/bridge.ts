/**
 * Wails 桥接层（quail 桌面壳专用）。
 *
 * - 仅在 Wails WebView 环境激活（`window.__wails` 存在）；浏览器预览环境
 *   全部方法静默降级（isWails() = false），行为与旧版一致；
 * - 所有 bindings import 集中于本文件：`wails3 generate bindings -d src/bindings`
 *   生成产物路径如与下方常量不符，只需改这两行；
 * - 事件名使用后端枚举生成的 TS 值（EventType），未生成时回退字面量。
 */

/** bindings 生成产物根目录（相对本文件） */
const BINDINGS_ROOT = "../bindings/quail";

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
  selectionProxy: boolean;
  recentFiles: string[];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnySrv = { [k: string]: (...args: any[]) => Promise<any> };

let services: { app: AnySrv; file: AnySrv; config: AnySrv } | null = null;
let runtime: any = null;

/** 是否运行在 Wails WebView 内 */
export function isWails(): boolean {
  return typeof window !== "undefined" && "__wails" in window;
}

async function ensureServices(): Promise<{ app: AnySrv; file: AnySrv; config: AnySrv } | null> {
  if (!isWails()) return null;
  if (services) return services;
  try {
    const mod = (await import(/* @vite-ignore */ `${BINDINGS_ROOT}/AppService`)) as any;
    const fileMod = (await import(/* @vite-ignore */ `${BINDINGS_ROOT}/FileService`)) as any;
    const cfgMod = (await import(/* @vite-ignore */ `${BINDINGS_ROOT}/ConfigService`)) as any;
    // v3 生成产物按服务名导出单例，命名形如 `new AppService(...)` 的实例或同名对象；
    // 统一取模块第一个导出的"方法容器"。
    const pick = (m: any): AnySrv => {
      for (const v of Object.values(m)) {
        if (v && typeof v === "object") return v as AnySrv;
      }
      return m;
    };
    services = { app: pick(mod), file: pick(fileMod), config: pick(cfgMod) };
    return services;
  } catch (e) {
    console.warn("[bridge] bindings 加载失败，降级为本地模式", e);
    return null;
  }
}

async function ensureRuntime(): Promise<any> {
  if (!runtime) {
    runtime = await import("@wailsio/runtime");
  }
  return runtime;
}

/* ---------------- AppService ---------------- */

/** 首帧就绪：显示窗口 */
export async function ready(): Promise<void> {
  const s = await ensureServices();
  if (!s) return;
  await s.app.Ready();
}

/** 上报脏状态 */
export async function reportDirty(dirty: boolean): Promise<void> {
  const s = await ensureServices();
  if (!s) return;
  await s.app.HasUnsavedChanges(dirty);
}

/* ---------------- FileService ---------------- */

/** 打开文档（系统文件对话框由前端组合：这里接收路径） */
export async function openDocument(path?: string): Promise<QuailDocState | null> {
  const s = await ensureServices();
  if (!s) return null;
  const p = path || (await s.file.PickOpen());
  if (!p) return null;
  return (await s.file.Open(p)) as QuailDocState;
}

/** 保存当前文档 */
export async function saveDocument(content: string, force = false): Promise<QuailSaveResult> {
  const s = await ensureServices();
  if (!s) throw new Error("not-in-wails");
  return (await s.file.Save(content, force)) as QuailSaveResult;
}

/** 另存为 */
export async function saveDocumentAs(path: string, content: string): Promise<QuailSaveResult> {
  const s = await ensureServices();
  if (!s) throw new Error("not-in-wails");
  return (await s.file.SaveAs(path, content)) as QuailSaveResult;
}

/** 确认退出（close:request 确认后调用） */
export async function confirmQuit(): Promise<void> {
  const s = await ensureServices();
  if (!s) return;
  await s.app.ConfirmQuit();
}

/** 弹系统打开对话框并打开所选文档（无路径选中返回 null） */
export async function openViaDialog(): Promise<QuailDocState | null> {
  const s = await ensureServices();
  if (!s) return null;
  const path = (await s.file.PickOpen()) as string;
  if (!path) return null;
  return (await s.file.Open(path)) as QuailDocState;
}

/** 弹系统另存对话框并保存（取消返回 null） */
export async function saveAsViaDialog(content: string): Promise<QuailSaveResult | null> {
  const s = await ensureServices();
  if (!s) return null;
  const path = (await s.file.PickSave("untitled.md")) as string;
  if (!path) return null;
  return (await s.file.SaveAs(path, content)) as QuailSaveResult;
}

/** 关闭当前文档 */
export async function closeDocument(): Promise<void> {
  const s = await ensureServices();
  if (!s) return;
  await s.file.CloseDoc();
}

/* ---------------- ConfigService ---------------- */

/** 读取配置（null = 非 wails 环境） */
export async function loadConfig(): Promise<QuailConfig | null> {
  const s = await ensureServices();
  if (!s) return null;
  return (await s.config.Get()) as QuailConfig;
}

/** 配置文件是否已存在（false = 需要 localStorage 一次性迁移） */
export async function configExists(): Promise<boolean> {
  const s = await ensureServices();
  if (!s) return false;
  return (await s.config.ConfigExists()) as boolean;
}

/** 保存配置（整包） */
export async function persistConfig(cfg: QuailConfig): Promise<void> {
  const s = await ensureServices();
  if (!s) return;
  await s.config.Save(cfg);
}

/* ---------------- 事件 ---------------- */

export type FileEventName = "file:changed" | "file:deleted";
export type ConfigEventName = "config:changed";
export type CloseEventName = "close:request";

/** 订阅后端事件（返回取消函数） */
export async function onBackendEvent(
  name: FileEventName | ConfigEventName | CloseEventName,
  handler: (data: any) => void
): Promise<(() => void) | null> {
  if (!isWails()) return null;
  try {
    const rt = await ensureRuntime();
    const off = rt.Events.On(name, (ev: any) => handler(ev?.data));
    return () => {
      try {
        if (typeof off === "function") off();
      } catch { /* ignore */ }
    };
  } catch {
    return null;
  }
}
