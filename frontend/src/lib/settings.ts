/**
 * 设置存储抽象：后端 ConfigService（~/.config/quail/settings.json）为唯一事实源。
 *
 * - get/set 读写内存快照；set 记录脏字段，防抖后仅把脏字段增量回写
 *   后端（SaveFields 与磁盘最新配置按字段合并，多窗口/多实例互不覆盖）；
 *   历史上的 localStorage 直通与一次性迁移已随浏览器模式移除，项目中不再
 *   存在任何 localStorage 调用；
 * - 后端 config:changed 事件（其他窗口保存 / 外部改配置文件）→ 快照刷新 +
 *   重放到各 store；重放期间 store 回写不视为本地修改，本地尚未落盘的脏
 *   字段不被远端广播回退（避免编辑中的设置"跳回原值"）。
 */

import { loadConfig, persistConfigFields, onBackendEvent } from "./bridge";

/** 后端 Config JSON 字段 ↔ 前端设置键（md.*）的映射 */
const KEY_MAP: Record<string, string> = {
  "md.mode": "mode",
  "md.defaultLayout": "defaultLayout",
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
let saveTimer: ReturnType<typeof setTimeout> | null = null;
/** 距上次落盘仍待回写的脏字段（增量保存的单位） */
let dirtyFields = new Set<string>();
/** 快照就绪门闸：store 工厂在模块加载期（早于快照加载）创建并立即回写兜底值，
 *  未就绪前禁止回写，避免兜底默认值抢先覆盖磁盘配置 */
let ready = false;
/** 远端配置重放中：重放触发的 store 订阅回写是回声而非本地修改，
 *  不记脏、不触发回写（否则多窗口间会形成保存-广播-保存乒乓循环） */
let replaying = false;

/** 同步读（store 工厂在模块加载期调用；快照未加载时返回 null → store 用兜底默认值） */
export function kvGet(key: string): string | null {
  const v = snapshot[KEY_MAP[key] ?? key.slice(LS_PREFIX.length)];
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? "1" : "0";
  return String(v);
}

/** 同步写；记录脏字段，防抖后增量回写后端 */
export function kvSet(key: string, value: string): void {
  if (!ready) return; // 快照未加载，丢弃 store 初始化期的兜底回写
  const field = KEY_MAP[key] ?? key.slice(LS_PREFIX.length);
  snapshot[field] = value === "1" && typeof snapshot[field] === "boolean" ? true : coerce(field, value);
  if (replaying) return; // 远端重放触发的 store 回声，不视为本地修改
  dirtyFields.add(field);
  scheduleSave();
}

/** KV 里以 "1"/"0" 字符串表示布尔字段，数值字段转 number */
function coerce(field: string, raw: string): unknown {
  const n = Number(raw);
  if ((field === "fontSizeEditor" || field === "fontSizePreview") && Number.isFinite(n)) return n;
  return raw;
}

function scheduleSave(): void {
  if (dirtyFields.size === 0) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (dirtyFields.size === 0) return;
    // 仅提交脏字段：后端与磁盘最新配置按字段合并，陈旧字段不参与覆盖
    const fields = dirtyFields;
    dirtyFields = new Set();
    const partial: Record<string, unknown> = {};
    for (const f of fields) partial[f] = snapshot[f];
    void persistConfigFields(partial).catch(() => {
      for (const f of fields) dirtyFields.add(f); // 失败待重试
    });
  }, SAVE_DEBOUNCE);
}

/** 外部配置变更（config:changed）→ 重放回调（stores.ts 注册 applyBackendConfig） */
let replay: ((snap: Snapshot) => void) | null = null;
export function onConfigReplay(cb: (snap: Snapshot) => void): void {
  replay = cb;
}

/* ---------------- 启动：加载 / 订阅 ---------------- */

/** boot 阶段调用一次（bootApp 内 await） */
export async function initSettings(): Promise<void> {
  const cfg = await loadConfig();
  if (cfg) {
    snapshot = { ...(cfg as unknown as Snapshot) };
  }

  // 快照就绪：放开回写门闸，并把磁盘配置主动重放进各 store。
  // store 工厂创建于模块加载期（早于此处），kvGet 当时拿到的是空快照，
  // 各 store 均为兜底默认值——不在此处重放，启动后将永远读不到已保存的设置。
  ready = true;
  replaySnapshot(snapshot);

  // 其他窗口保存 / 外部修改配置文件 → 刷新快照并重放到 store。
  // - 与本地快照一致的回声（自身 SaveFields 落盘后的广播）直接跳过；
  // - 合并时保留本地尚未落盘的脏字段原值：本窗口 300ms 防抖窗口内的修改
  //   不被远端携带的旧值回退（否则编辑中的控件会"跳回原值"）。
  await onBackendEvent("config:changed", (data: { config?: Snapshot } | undefined) => {
    if (!data?.config) return;
    if (configMatchesSnapshot(data.config)) return;
    const local = new Map<string, unknown>();
    for (const f of dirtyFields) local.set(f, snapshot[f]);
    snapshot = { ...snapshot, ...data.config };
    for (const [f, v] of local) snapshot[f] = v;
    replaySnapshot(snapshot);
  });
}

/** 把快照重放进各 store：重放期间 kvSet 回声不记脏（防乒乓保存循环） */
function replaySnapshot(snap: Snapshot): void {
  replaying = true;
  try {
    replay?.(snap);
  } finally {
    replaying = false;
  }
}

/** 广播配置与本地快照是否一致（字段逐一规范化比较，忽略类型差异） */
function configMatchesSnapshot(cfg: Snapshot): boolean {
  const norm = (v: unknown): string => {
    if (typeof v === "boolean") return v ? "1" : "0";
    return v == null ? "" : String(v);
  };
  for (const field of new Set(Object.values(KEY_MAP))) {
    if (norm(snapshot[field]) !== norm(cfg[field])) return false;
  }
  return true;
}
