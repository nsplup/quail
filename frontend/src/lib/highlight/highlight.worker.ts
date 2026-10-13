/**
 * 预览代码块着色 worker：highlight.js 解析 + IndexedDB 持久缓存 + 闲时清理。
 *
 * 【worker 专属模块】由 hl-client.ts 以 module worker 启动；不 import 任何
 * UI 侧模块（仅 contentHash 纯函数），hljs 主包纯 JS、零 DOM 依赖。
 *
 * 缓存设计（权威缓存在 worker，主线程无缓存状态）：
 * - 键 = contentHash(lang + "\0" + code)（内容寻址，复用 lib/worker/contentHash）：
 *   同一代码块编辑 N 次 = N 个不同键、每键恰一条记录，不存在「同块多副本」；
 *   相同内容的不同代码块 / 滚动往返重挂载 / 重开文档全部命中同一条；
 * - 两级：内存热 LRU（HOT_MAX 条，承接虚拟化滚回的即时命中）
 *   → IndexedDB（持久层，记录含 lastAccess/size）→ 未命中才解析；
 * - 命中续期惰性化：TOUCH_MS 内的重复命中不写 IDB；
 * - in-flight 去重：同 hash 并发请求合并为一次解析。
 *
 * 闲时清理（LRU + TTL，可暂停可恢复；无周期定时器）：
 * - 触发时机仅两个：worker 启动 / 解析队列排空（pending 归零）——两者都只做
 *   一次廉价的 meta 读：IDB meta 存「上次清理执行时间戳」（lastGcAt），
 *   距上次清理超过 24h 且队列空闲才真正执行（时间戳在启动本轮时立即落库，
 *   防止中途崩溃后反复清理）；
 * - 执行：TTL 清除（lastAccess 超 7 天，lastAccess 索引升序分批 getAll）→
 *   LRU 裁剪（条目 / 字节超上限时从最旧开始删）；小批次（GC_BATCH）推进，
 *   批间 setTimeout 让出事件循环；
 * - 暂停/恢复：批次边界检查解析队列（pending > 0 → 本轮挂起）；队列排空且
 *   空闲 GC_RESUME_DELAY 后续跑。清理幂等（每批按当前条件重新判定，
 *   无游标状态），挂起/恢复不丢一致性。
 */
import hljs from "highlight.js";
import { contentHash } from "../worker/contentHash";
import type { HlIn, HlOut, HlSkip } from "./protocol";

/* ---------------- 语言：主包全量自动注册 + 别名归一 ----------------
 * 桌面应用无网络加载成本，不维护 curated 语言清单：直接导入主包
 * highlight.js，193 种语言及其内置别名（js/ts/py/golang…）在模块加载时
 * 自动注册。围栏信息串先经 LANG_ALIAS 归一（覆盖主包未收录的社区别名），
 * 再查 hljs 注册表；未命中 → nolang（纯文本，不解析）。
 * 桌面本地加载全量语言包无网络成本，体积代价可接受；同步查表解析。 */

/** 围栏信息串别名 → 规范语言名（hljs 模块注册名） */
const LANG_ALIAS: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  node: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  py3: "python",
  golang: "go",
  rs: "rust",
  kt: "kotlin",
  kts: "kotlin",
  rb: "ruby",
  "c++": "cpp",
  cxx: "cpp",
  cc: "cpp",
  hpp: "cpp",
  "c#": "csharp",
  cs: "csharp",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  yml: "yaml",
  toml: "ini", // hljs 无独立 toml 语法，ini 语法覆盖（社区惯例）
  html: "xml",
  htm: "xml",
  svg: "xml",
  vue: "xml",
  sass: "scss",
  gmake: "makefile",
  docker: "dockerfile",
};

/** 确保语言可用；返回规范语言名（不可用返回 null）。
 *  主包全量注册后为同步查表：LANG_ALIAS 归一 + getLanguage 命中检查 */
function ensureLanguage(lang: string): string | null {
  const canonical = LANG_ALIAS[lang] ?? lang;
  return hljs.getLanguage(canonical) ? canonical : null;
}

/* ---------------- 常量 ---------------- */
const HOT_MAX = 64; // 内存热缓存条数上限（LRU）
const IDB_MAX_ENTRIES = 1000; // 持久层条目上限（LRU）
const IDB_MAX_BYTES = 8 * 1024 * 1024; // 持久层字节上限（LRU；html.length 近似）
const TTL_MS = 7 * 24 * 3600_000; // lastAccess 过期时间（7 天）
const TOUCH_MS = 3600_000; // 命中续期惰性阈值（1h 内重复命中不写 IDB）
const GC_MIN_INTERVAL = 24 * 3600_000; // 距上次清理超过 24h 才执行（lastGcAt）
const GC_BATCH = 50; // 清理批大小（批间让出事件循环）
const GC_RESUME_DELAY = 30_000; // 解析队列排空后恢复清理的空闲间隔
const MAX_CODE_LEN = 256 * 1024; // 超大代码块不着色（toolarge 降级纯文本）

/* ---------------- IndexedDB ---------------- */
const DB_NAME = "quail-hl-cache";
const DB_VERSION = 1;
const STORE = "highlights"; // keyPath: hash
const META = "meta"; // keyPath: key
const GC_KEY = "lastGcAt";
const TOTALS_KEY = "totals";

interface HlEntry {
  hash: string;
  lang: string;
  html: string;
  /** html.length（UTF-16 单位近似字节），LRU 字节上限与裁剪的依据 */
  size: number;
  lastAccess: number;
  createdAt: number;
}
interface Totals {
  entries: number;
  bytes: number;
}
interface MetaRow {
  key: string;
  value: unknown;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore(STORE, { keyPath: "hash" }).createIndex("lastAccess", "lastAccess");
        db.createObjectStore(META, { keyPath: "key" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null); // IDB 不可用（隐私模式等）→ 仅热缓存，解析照常
    }
  });
  return dbPromise;
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}

/** 容量合计的内存镜像（worker 单线程，本模块内即权威）；null = 尚未加载 */
let totals: Totals | null = null;

/** 加载容量合计；元数据缺失时一次性全量重建并落库 */
async function loadTotals(db: IDBDatabase): Promise<Totals> {
  if (totals) return totals;
  const row = await reqToPromise(db.transaction(META, "readonly").objectStore(META).get(TOTALS_KEY));
  const v = (row as MetaRow | undefined)?.value as Totals | undefined;
  if (v && typeof v.entries === "number" && typeof v.bytes === "number") {
    totals = v;
    return totals;
  }
  let entries = 0;
  let bytes = 0;
  await new Promise<void>((resolve) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) {
        resolve();
        return;
      }
      const e = cur.value as HlEntry;
      entries++;
      bytes += e.size || 0;
      cur.continue();
    };
    req.onerror = () => resolve();
  });
  totals = { entries, bytes };
  const tx = db.transaction(META, "readwrite");
  tx.objectStore(META).put({ key: TOTALS_KEY, value: totals } satisfies MetaRow);
  await txDone(tx);
  return totals;
}

async function idbGetEntry(db: IDBDatabase, hash: string): Promise<HlEntry | undefined> {
  return reqToPromise(db.transaction(STORE, "readonly").objectStore(STORE).get(hash));
}

/** 命中续期（惰性：仅当距上次访问超过 TOUCH_MS 才写） */
async function touchEntry(db: IDBDatabase, hash: string): Promise<void> {
  try {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const entry = (await reqToPromise(store.get(hash))) as HlEntry | undefined;
    if (entry) store.put({ ...entry, lastAccess: Date.now() } satisfies HlEntry);
    await txDone(tx);
  } catch {
    /* 续期失败不影响正确性 */
  }
}

/** 新增/覆盖一条缓存（同事务更新容量合计，保持两存储一致） */
async function idbPutEntry(db: IDBDatabase, entry: HlEntry): Promise<void> {
  const t = totals ?? { entries: 0, bytes: 0 };
  const next: Totals = { entries: t.entries + 1, bytes: t.bytes + entry.size };
  const tx = db.transaction([STORE, META], "readwrite");
  tx.objectStore(STORE).put(entry);
  tx.objectStore(META).put({ key: TOTALS_KEY, value: next } satisfies MetaRow);
  await txDone(tx);
  totals = next;
}

/** 批量删除（同事务更新容量合计） */
async function deleteEntries(db: IDBDatabase, entries: HlEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const removedBytes = entries.reduce((s, e) => s + (e.size || 0), 0);
  for (const e of entries) hot.delete(e.hash);
  const t = totals ?? { entries: 0, bytes: 0 };
  const next: Totals = {
    entries: Math.max(0, t.entries - entries.length),
    bytes: Math.max(0, t.bytes - removedBytes),
  };
  const tx = db.transaction([STORE, META], "readwrite");
  const store = tx.objectStore(STORE);
  for (const e of entries) store.delete(e.hash);
  tx.objectStore(META).put({ key: TOTALS_KEY, value: next } satisfies MetaRow);
  await txDone(tx);
  totals = next;
}

/* ---------------- 内存热缓存（LRU，Map 插入序 = 最近使用序） ---------------- */
const hot = new Map<string, string>();

function hotGet(hash: string): string | undefined {
  const v = hot.get(hash);
  if (v !== undefined) {
    hot.delete(hash);
    hot.set(hash, v);
  }
  return v;
}

function hotPut(hash: string, html: string): void {
  hot.delete(hash);
  hot.set(hash, html);
  while (hot.size > HOT_MAX) {
    const oldest = hot.keys().next().value;
    if (oldest === undefined) break;
    hot.delete(oldest);
  }
}

/* ---------------- 解析（含 in-flight 去重） ---------------- */
type HlOutcome =
  | { ok: true; html: string; from: "hot" | "idb" | "parse" }
  | { ok: false; reason: HlSkip["reason"] };

/** 未回包的解析请求数（> 0 = 忙，清理挂起） */
let pending = 0;
const inflight = new Map<string, Promise<HlOutcome>>();

async function doResolve(lang: string, code: string, hash: string): Promise<HlOutcome> {
  const hotHit = hotGet(hash);
  if (hotHit !== undefined) return { ok: true, html: hotHit, from: "hot" };

  const db = await openDb();
  if (db) {
    try {
      const entry = await idbGetEntry(db, hash);
      if (entry && typeof entry.html === "string") {
        hotPut(hash, entry.html);
        if (Date.now() - entry.lastAccess > TOUCH_MS) void touchEntry(db, entry.hash);
        return { ok: true, html: entry.html, from: "idb" };
      }
    } catch {
      /* IDB 异常 → 继续解析路径 */
    }
  }

  const canonical = await ensureLanguage(lang);
  if (canonical === null) return { ok: false, reason: "nolang" };
  let html: string;
  try {
    html = hljs.highlight(code, { language: canonical, ignoreIllegals: true }).value;
  } catch {
    return { ok: false, reason: "error" };
  }
  hotPut(hash, html);
  if (db) {
    const now = Date.now();
    void idbPutEntry(db, {
      hash,
      lang: canonical,
      html,
      size: html.length,
      lastAccess: now,
      createdAt: now,
    }).catch(() => {});
  }
  return { ok: true, html, from: "parse" };
}

function resolveOutcome(lang: string, code: string): Promise<HlOutcome> {
  const hash = contentHash(lang + "\0" + code);
  const running = inflight.get(hash);
  if (running) return running;
  const p = doResolve(lang, code, hash).finally(() => inflight.delete(hash));
  inflight.set(hash, p);
  return p;
}

/* ---------------- 闲时清理（LRU + TTL；触发 = 启动 / 队列排空，无周期定时器） ---------------- */
let gcRunning = false; // 本轮清理进行中（含因解析忙而挂起的阶段）
let gcSuspended = false; // 本轮清理当前处于挂起状态
let resumeTimer: ReturnType<typeof setTimeout> | undefined;

const yieldToLoop = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** lastAccess 索引升序取最旧一批（range=null 时从头取） */
async function oldestBatch(db: IDBDatabase, range: IDBKeyRange | null, count: number): Promise<HlEntry[]> {
  const idx = db.transaction(STORE, "readonly").objectStore(STORE).index("lastAccess");
  return reqToPromise(idx.getAll(range ?? undefined, count));
}

function suspendGc(): void {
  gcSuspended = true;
  queueResume();
}

/** 队列排空且空闲 GC_RESUME_DELAY 后续跑本轮清理 */
function queueResume(): void {
  if (resumeTimer !== undefined) return;
  resumeTimer = setTimeout(() => {
    resumeTimer = undefined;
    if (pending === 0 && gcRunning) void resumeGc();
    /* 仍忙：不再调度——下一次 pending 归零（handleHl finally）会重新 queueResume */
  }, GC_RESUME_DELAY);
}

async function resumeGc(): Promise<void> {
  gcSuspended = false;
  const db = await openDb();
  if (!db) {
    gcRunning = false;
    return;
  }
  if (pending > 0) {
    suspendGc();
    return;
  }
  await gcSweep(db);
  gcRunning = false;
}

async function gcSweep(db: IDBDatabase): Promise<void> {
  const expireBefore = Date.now() - TTL_MS;
  /* pass 1：TTL 过期清除（lastAccess 升序，分批 getAll → 整批删除） */
  for (;;) {
    if (pending > 0) {
      suspendGc();
      return;
    }
    let batch: HlEntry[];
    try {
      batch = await oldestBatch(db, IDBKeyRange.upperBound(expireBefore), GC_BATCH);
    } catch {
      break;
    }
    if (batch.length === 0) break;
    await deleteEntries(db, batch);
    await yieldToLoop();
  }
  /* pass 2：LRU 容量裁剪（最旧优先，删到条目 / 字节回到上限内即止） */
  for (;;) {
    if (totals === null) {
      try {
        await loadTotals(db);
      } catch {
        break;
      }
    }
    const t = totals as Totals;
    const overEntries = t.entries - IDB_MAX_ENTRIES;
    const overBytes = t.bytes - IDB_MAX_BYTES;
    if (overEntries <= 0 && overBytes <= 0) break;
    if (pending > 0) {
      suspendGc();
      return;
    }
    let batch: HlEntry[];
    try {
      batch = await oldestBatch(db, null, GC_BATCH);
    } catch {
      break;
    }
    if (batch.length === 0) break; // 防御：合计与实际数据不一致时避免死循环
    const victims: HlEntry[] = [];
    let needEntries = overEntries;
    let needBytes = overBytes;
    for (const e of batch) {
      if (needEntries <= 0 && needBytes <= 0) break;
      victims.push(e);
      needEntries--;
      needBytes -= e.size || 0;
    }
    await deleteEntries(db, victims);
    await yieldToLoop();
  }
}

/** 清理检查：IDB lastGcAt 超 24h 且队列空闲才真正启动（时间戳立即落库防重入） */
async function gcCheck(): Promise<void> {
  if (gcRunning) return;
  const db = await openDb();
  if (!db) return;
  try {
    const row = await reqToPromise(db.transaction(META, "readonly").objectStore(META).get(GC_KEY));
    const last = (row as MetaRow | undefined)?.value;
    if (typeof last === "number" && Date.now() - last < GC_MIN_INTERVAL) return;
    if (pending > 0) return; // 忙时不启动；下次触发时机再查
    const tx = db.transaction(META, "readwrite");
    tx.objectStore(META).put({ key: GC_KEY, value: Date.now() } satisfies MetaRow);
    await txDone(tx);
    await loadTotals(db);
  } catch {
    return; // meta 读/写失败：跳过本轮，不影响解析
  }
  gcRunning = true;
  await gcSweep(db);
  gcRunning = false;
}

/* ---------------- 消息入口 ---------------- */
const postMessage = (msg: HlOut): void =>
  (self as unknown as { postMessage: (m: HlOut) => void }).postMessage(msg);

async function handleHl(msg: HlIn): Promise<void> {
  pending++;
  try {
    let out: HlOut;
    if (msg.lang === "") {
      out = { type: "hl:skip", id: msg.id, reason: "nolang" };
    } else if (msg.code.length > MAX_CODE_LEN) {
      out = { type: "hl:skip", id: msg.id, reason: "toolarge" };
    } else {
      const r = await resolveOutcome(msg.lang, msg.code);
      out = r.ok
        ? { type: "hl:ok", id: msg.id, html: r.html, from: r.from }
        : { type: "hl:skip", id: msg.id, reason: r.reason };
    }
    postMessage(out);
  } catch {
    postMessage({ type: "hl:skip", id: msg.id, reason: "error" });
  } finally {
    pending--;
    if (pending === 0 && gcRunning && gcSuspended) queueResume();
    if (pending === 0 && !gcRunning) void gcCheck(); // 队列排空 → 顺手检查是否该清理（>24h 才会真正执行）
  }
}

self.onmessage = (e: MessageEvent<HlIn>) => {
  const msg = e.data;
  if (!msg || msg.type !== "hl") return;
  void handleHl(msg);
};

/* 启动：加载容量合计 + 首次清理检查 */
void (async () => {
  const db = await openDb();
  if (db) {
    try {
      await loadTotals(db);
    } catch {
      /* 合计缺失时 put 会按 0 起步，下次启动重建，不影响正确性 */
    }
  }
  void gcCheck();
})();
