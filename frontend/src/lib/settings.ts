/**
 * 设置存储抽象：统一 localStorage 持久化与 Wails 后端配置两种模式。
 *
 * - 浏览器环境：localStorage 直通（与旧行为一致）；
 * - Wails 环境：以后端 ConfigService（~/.config/quail/settings.json）为唯一
 *   事实源。get/set 读写内存快照；set 防抖后整包回写后端；boot 时一次性
 *   迁移旧 localStorage 值（仅当后端配置文件尚不存在）；
 * - 后端 config:changed 事件（外部改配置文件）→ 快照刷新 + 重放到各 store。
 */

import { loadConfig, persistConfig, configExists, onBackendEvent } from "./bridge";

/** 后端 Config JSON 字段 ↔ 前端 localStorage 键 的映射 */
const KEY_MAP: Record<string, string> = {
  "md.mode": "mode",
  "md.theme": "theme",
  "md.lang": "locale",
  "md.indent": "indent",
  "md.countMode": "countMode",
  "md.fontEditor": "fontEditor",
  "md.fontPreview": "fontPreview",
  "md.fontSizeEd": "fontSizeEditor",
  "md.fontSizePv": "fontSizePreview",
};

const LS_PREFIX = "md.";
const SAVE_DEBOUNCE = 300;

type Snapshot = Record<string, unknown>;

let snapshot: Snapshot = {};
let wailsMode = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let snapshotDirty = false;

/** 同步读（store 工厂在模块加载期调用；wails 快照未加载时返回 fallback） */
export function kvGet(key: string): string | null {
  if (!wailsMode) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }
  const v = snapshot[KEY_MAP[key] ?? key.slice(LS_PREFIX.length)];
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? "1" : "0";
  return String(v);
}

/** 同步写；wails 模式下防抖回写后端 */
export function kvSet(key: string, value: string): void {
  if (!wailsMode) {
    try {
      localStorage.setItem(key, value);
    } catch { /* ignore */ }
    return;
  }
  const field = KEY_MAP[key] ?? key.slice(LS_PREFIX.length);
  snapshot[field] = value === "1" && typeof snapshot[field] === "boolean" ? true : coerce(field, value);
  snapshotDirty = true;
  scheduleSave();
}

/** localStorage 存的是 "1"/"0" 的布尔字段 */
function coerce(field: string, raw: string): unknown {
  const n = Number(raw);
  if ((field === "fontSizeEditor" || field === "fontSizePreview") && Number.isFinite(n)) return n;
  return raw;
}

function scheduleSave(): void {
  if (!snapshotDirty) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (!snapshotDirty || !wailsMode) return;
    snapshotDirty = false;
    void persistConfig(snapshot as never).catch(() => {
      snapshotDirty = true; // 失败待重试
    });
  }, SAVE_DEBOUNCE);
}

/** 外部配置变更（config:changed）→ 重放回调（stores.ts 注册 applyBackendConfig） */
let replay: ((snap: Snapshot) => void) | null = null;
export function onConfigReplay(cb: (snap: Snapshot) => void): void {
  replay = cb;
}

/* ---------------- 启动：加载 / 迁移 / 订阅 ---------------- */

/** boot 阶段调用一次（bootApp 内 await） */
export async function initSettings(): Promise<void> {
  wailsMode = true;

  const [cfg, exists] = await Promise.all([loadConfig(), configExists()]);
  if (cfg) {
    if (!exists) {
      // 一次性迁移：后端配置文件不存在 → 以旧 localStorage 值初始化并固化
      snapshot = { ...(cfg as unknown as Snapshot) };
      migrateFromLocalStorage(snapshot);
      snapshotDirty = true;
      await persistConfig(cfg).catch(() => undefined);
    } else {
      snapshot = { ...(cfg as unknown as Snapshot) };
    }
  }

  // 外部修改配置文件 → 刷新快照并重放到 store
  await onBackendEvent("config:changed", (data: { config?: Snapshot } | undefined) => {
    if (!data?.config) return;
    snapshot = { ...snapshot, ...data.config };
    replay?.(snapshot);
  });
}

/** 把 localStorage 中 md.* 非空值合并进快照（仅首次迁移） */
function migrateFromLocalStorage(snap: Snapshot): void {
  for (const lsKey of Object.keys(KEY_MAP)) {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(lsKey);
    } catch { /* ignore */ }
    if (raw != null && raw !== "") snap[KEY_MAP[lsKey]] = coerce(KEY_MAP[lsKey], raw);
  }
}
