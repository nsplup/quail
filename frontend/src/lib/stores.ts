/**
 * 全局状态中心：所有跨组件共享状态统一由 svelte store 持有。
 * - 持久化设置：persisted* 工厂在 store 创建时读入 localStorage，订阅期自动回写；
 * - 解析管线：doc$ 变化 → rAF 合并 + 自适应 minInterval + 120ms maxWait →
 *   发送到解析 worker（增量/全量由 worker 内部决定）→ 段级补丁回传
 *   → segments$/blocks$/outline$/counts$（未变段引用复用 → Svelte 跳过子树）；
 *   解析阶段/渐进渲染进度由 parsePhase$/renderProgress$ 对外报告；
 * - 组件私有交互细节（拖拽、程序滚动时间窗等）仍留在组件内，不在此处。
 */
import { writable, derived, get, type Writable } from "svelte/store";
import type {
  Mode,
  ThemeId,
  IndentId,
  CountMode,
  OutlineItem,
  ParsePhase,
  PreviewApi,
  PreviewBlock,
} from "./types";
import type { EditorApi } from "./editor/codemirrorSetup";
import { blockIndexForLine } from "./markdown";
import type { HastSegment } from "./markdown/markdown-core";
import { createParseClient } from "./worker/parse-client";
import { t, locale, setLang } from "./i18n.svelte";
import { kvGet, kvSet, onConfigReplay, initSettings } from "./settings";
import { onBackendEvent, ready as bridgeReady, startupDoc, type QuailDocState } from "./bridge";

/* ---------------- 持久化工厂 ---------------- */

function persistedEnum<T extends string>(
  key: string,
  fallback: T,
  valid: readonly T[]
): Writable<T> {
  let initial = fallback;
  try {
    const v = kvGet(key) as T | null;
    if (v && valid.includes(v)) initial = v;
  } catch { /* ignore */ }
  const store = writable<T>(initial);
  store.subscribe((v) => kvSet(key, v));
  return store;
}

function persistedText(key: string, fallback = ""): Writable<string> {
  let initial = fallback;
  try {
    const v = kvGet(key);
    if (v != null && v.trim() !== "") initial = v;
  } catch { /* ignore */ }
  const store = writable<string>(initial);
  store.subscribe((v) => kvSet(key, v));
  return store;
}

function persistedNumber(key: string, fallback: number): Writable<number> {
  let initial = fallback;
  try {
    const raw = kvGet(key);
    if (raw != null) {
      const v = Number(raw);
      if (Number.isFinite(v)) initial = v;
    }
  } catch { /* ignore */ }
  const store = writable<number>(initial);
  store.subscribe((v) => kvSet(key, String(v)));
  return store;
}

function persistedBool(key: string, fallback: boolean): Writable<boolean> {
  let initial = fallback;
  try {
    const v = kvGet(key);
    if (v != null) initial = v === "1";
  } catch { /* ignore */ }
  const store = writable<boolean>(initial);
  store.subscribe((v) => kvSet(key, v ? "1" : "0"));
  return store;
}

/* ---------------- 设置（持久化） ---------------- */

export const mode$ = persistedEnum<Mode>("md.mode", "split", ["source", "split", "preview"] as const);

export const theme$ = persistedEnum<ThemeId>(
  "md.theme",
  "ayu-dark",
  ["ayu-dark", "ayu-mirage", "ayu-light", "one-dark-pro", "dracula", "nord", "tokyo-night", "github-light", "github-dark", "solarized-light"] as const
);

export const indent$ = persistedEnum<IndentId>("md.indent", "tab", ["tab", "space2", "space4"] as const);

/** 字数统计方式（auto = 跟随界面语言） */
export const countMode$ = persistedEnum<CountMode>("md.countMode", "auto", ["auto", "words", "chars"] as const);

/** 编辑区/预览区字体（空值 = 使用回退链默认值） */
export const fontEditor$ = persistedText("md.fontEditor", "");
export const fontPreview$ = persistedText("md.fontPreview", "");

/** 编辑区/预览区字号（px） */
export const fontSizeEd$ = persistedNumber("md.fontSizeEd", 15);
export const fontSizePv$ = persistedNumber("md.fontSizePv", 15.5);

/* ---------------- UI 状态 ---------------- */

export const settingsOpen$ = writable(false);
export const outlineOpen$ = writable(false);
/** 大纲追踪激活项：滚动同步（自动切换）时为 true；点击跳转后为 false */
export const outlineAutoTrack$ = writable(true);
export const topIndex$ = writable(0);

/** toast：{id, msg}（id 驱动重置自动关闭计时） */
export const toast$ = writable<{ id: number; msg: string } | null>(null);

/* ---------------- 解析管线（worker 承载） ---------------- */

/** 编辑器文档（保存走后端，不落 localStorage） */
export const doc$ = writable("");

export const ready$ = writable(false);

/**
 * 预览段列表（worker splitSegments 的结果；渲染层数据源）。
 * 增量更新为段级 splice：未变段对象引用保持稳定 →
 * MarkdownNode 按 props 引用相等跳过子树（图片不重新请求）。
 */
export const segments$ = writable<HastSegment[]>([]);
/**
 * 全量重建纪元：仅在「冷启动全量」（worker 实例内首次解析：boot / 崩溃重建后）
 * 时 +1，渲染层据此重置渐进挂载状态。
 * 例行全量（25 次增量阈值 / idle 自愈 / 空态兜底）不递增——旧主线程版本里
 * 全量结果是 hast$ 原地替换、Svelte 原地 diff、用户无感；worker 重构后若
 * 每次例行全量都清空重放，增量渲染就会被周期性打断（整树卸载 + 图片重请求）。
 * 例行全量改走 fullBatchBuffer 缓冲 + result 到达后原子采纳（原地 diff）。
 */
export const renderEpoch$ = writable(0);
/** 最近一次增量补丁（渲染层据此把补丁区间立即纳入可见范围） */
export const patchHint$ = writable<{ segStart: number; segAdded: number } | null>(null);
/** 全量解析的完整段数（渐进渲染进度分母；增量时与 segments.length 同步） */
export const renderTotal$ = writable(0);
export const blocks$ = writable<PreviewBlock[]>([]);
/** 大纲（worker 由 mdast + blocks 计算后回传） */
export const outline$ = writable<OutlineItem[]>([]);
/** 字数统计（worker 按解析时刻源码快照计算后回传，主线程不再扫全文） */
export const counts$ = writable<{ words: number; hanChars: number }>({ words: 0, hanChars: 0 });

/** 预览解析/渲染阶段：parsing（worker 解析中）→ rendering（渐进挂载中）→ idle */
export const parsePhase$ = writable<ParsePhase>("idle");
/** 渐进渲染进度 0..1（visibleCount / total） */
export const renderProgress$ = writable(1);

/** 编辑器/预览 API 句柄（组件就绪后注入） */
export const editorApi$ = writable<EditorApi | null>(null);
/** 脏状态：当前文档与最近一次干净引用（初始化/保存时记录）不一致 */
export const dirty$ = writable(false);
export const previewApi$ = writable<PreviewApi | null>(null);

/* ---------------- 解析调度：rAF 合并 + 自适应 minInterval + maxWait + worker 背压 ----------------
 * 相比固定 500ms 防抖：输入流畅时下一帧即解析（预览延迟 500ms → ~16ms），
 * 高频全量替换时自适应拉长 minInterval 节流；maxWait 兜底防“永远没空档”；
 * worker 在途时积压最新 src，响应回齐后立即补跑（worker 串行处理，
 * 乱序发送会让增量补丁相对 worker 内部状态错位，故必须背压）。 */
const MIN_INTERVAL_BASE = 16;
const ADAPT_STEP = 32;
const MAX_INTERVAL = 256;
const MAX_WAIT = 120;

let minInterval = MIN_INTERVAL_BASE;
let lastRun = 0;
let pendingSrc: string | null = null;
let pendingForceFull = false;
let pending = false;
let adaptHits = 0;
let flushRaf: number | undefined;
let flushTimer: ReturnType<typeof setTimeout> | undefined;

/** 例行全量（cold=false）的批次缓冲：worker 分批发送期间暂存，
 * result(full=true) 到达后一次性 segments$.set 原子采纳。
 * 期间不写入 segments$，避免「批次边界处先卸载再重建」的中间态。
 * worker 消息严格有序且一次全量只有一套批次，无并发交织。 */
let fullBatchBuffer: HastSegment[] | null = null;

/** worker 客户端：生命周期/崩溃重建封装在 parse-client，stores 只关心数据 */
const parseClient = createParseClient({
  onBatch: (msg) => {
    if (!msg.cold) {
      // 例行全量：只缓冲（首批覆盖残留缓冲，防上一次全量中途出错遗留）
      fullBatchBuffer = msg.segStart === 0 ? msg.items : fullBatchBuffer?.concat(msg.items) ?? msg.items;
      return;
    }
    if (msg.segStart === 0) {
      // 冷启动首批：整列表重建 + 纪元递增（渲染层重置渐进挂载）
      fullBatchBuffer = null;
      segments$.set(msg.items);
      renderEpoch$.update((n) => n + 1);
    } else {
      segments$.update((arr) => [...arr, ...msg.items]);
    }
  },
  onResult: (msg) => {
    blocks$.set(msg.blocks);
    outline$.set(msg.outline);
    counts$.set(msg.counts);
    if (msg.full) {
      // 例行全量收口：原子采纳缓冲的完整段列表（原地 diff，未变内容不动 DOM、
      // 图片不重新请求；列表增长由渲染层渐进挂载追赶，缩短由 clamp 收敛）
      if (fullBatchBuffer !== null) {
        segments$.set(fullBatchBuffer);
        fullBatchBuffer = null;
      }
      renderTotal$.set(msg.totalSegments);
      parsePhase$.set("rendering"); // 是否仍有渐进工作由渲染层 onprogress 回报收敛
    } else {
      const { segStart, segCount, items } = msg.segments;
      segments$.update((arr) => {
        const next = arr.slice();
        next.splice(segStart, segCount, ...items);
        return next;
      });
      patchHint$.set({ segStart, segAdded: items.length });
      renderTotal$.set(msg.totalSegments);
      parsePhase$.set("rendering");
    }
    // 若调度器有积压 src（worker 在途期间的新编辑），立即补跑
    onWorkerDrained();
  },
  onWorkerError: (msg) => {
    console.warn("[parse] worker error:", msg.message);
    fullBatchBuffer = null; // 例行全量半途出错：丢弃残缺缓冲
    toast$.set({ id: Date.now(), msg: get(t)("toast.parseFailed") });
    scheduleRebuild(get(doc$), true); // worker 状态已重建，强制全量
  },
  onCrashed: () => {
    console.warn("[parse] worker crashed; restarting");
    fullBatchBuffer = null; // 崩溃：丢弃残缺缓冲（后续冷全量会整体重建）
    toast$.set({ id: Date.now(), msg: get(t)("toast.parseFailed") });
    scheduleRebuild(get(doc$), true);
  },
});

/** worker 响应回齐后的积压补跑（无在途、有积压 → rAF 快路径） */
function onWorkerDrained(): void {
  if (parseClient.busy()) return;
  if (pending && pendingSrc !== null && flushRaf === undefined && flushTimer === undefined) {
    flushRaf = requestAnimationFrame(flushNow);
    flushTimer = setTimeout(flushNow, MAX_WAIT);
  }
}

/** 高频触发（在途时又来新 src）计数：连续 ≥3 次 → 拉长 minInterval */
function noteAdapt(): void {
  adaptHits++;
  if (adaptHits >= 3) {
    minInterval = Math.min(MAX_INTERVAL, minInterval + ADAPT_STEP);
  }
}

/** 调度一次解析：rAF 快路径（无背压）+ minInterval 节流 + MAX_WAIT 强制兜底 */
function scheduleRebuild(src: string, forceFull = false): void {
  pendingSrc = src;
  pendingForceFull = forceFull;
  if (pending) {
    noteAdapt();
    return;
  }
  pending = true;
  adaptHits = 0;
  const since = performance.now() - lastRun;
  const delay = Math.max(0, minInterval - since);
  if (delay < MIN_INTERVAL_BASE && !parseClient.busy()) {
    // 快路径：下一帧解析；MAX_WAIT 双保险（rAF 被后台节流时仍按时解析）
    flushRaf = requestAnimationFrame(flushNow);
    flushTimer = setTimeout(flushNow, MAX_WAIT);
  } else {
    // 背压：minInterval 内刚跑过或 worker 在途 → 最多再等 MAX_WAIT
    flushTimer = setTimeout(flushNow, Math.min(delay, MAX_WAIT));
  }
}

/** 消费 pendingSrc 并发送解析请求（rAF/timer 竞争，单线程下先到先清） */
function flushNow(): void {
  flushRaf = undefined;
  clearTimeout(flushTimer);
  flushTimer = undefined;
  if (parseClient.busy()) return; // worker 在途：响应回齐后 onWorkerDrained 补跑
  pending = false;
  const s = pendingSrc;
  const ff = pendingForceFull;
  pendingSrc = null;
  pendingForceFull = false;
  if (s === null) return;
  lastRun = performance.now();
  parsePhase$.set("parsing");
  parseClient.request(s, ff);
  // 本轮无高频触发 → 向基准回落
  if (adaptHits === 0) {
    minInterval = Math.max(MIN_INTERVAL_BASE, minInterval - ADAPT_STEP);
  }
}

// doc$ 变化 → 记 pendingSrc → rAF 合并（ready 后生效；全量阈值/idle 自愈在 worker 内）
doc$.subscribe((src) => {
  if (!get(ready$)) return;
  scheduleRebuild(src);
});

let booted = false;


/** 派生：字数统计生效模式（auto 跟随界面语言） */
export const effectiveCountMode$ = derived([countMode$, locale], ([m, lang]) =>
  m === "auto" ? (lang === "zh" ? "chars" : "words") : m
);

/** 派生：字数统计标签（worker 回传的解析快照统计，主线程不扫全文） */
export const countLabel$ = derived(
  [counts$, effectiveCountMode$, t],
  ([counts, mode, tt]) => {
    if (mode === "chars") {
      return `${counts.hanChars.toLocaleString()} ${tt("stats.chars")}`;
    }
    return `${counts.words.toLocaleString()} ${tt("stats.words")}`;
  }
);

/** 派生：当前激活标题（topIndex 之前最后一个） */
export const activeHeading$ = derived([outline$, topIndex$], ([outline, topIndex]) => {
  let res: OutlineItem | null = null;
  for (const it of outline) {
    if (it.blockIndex <= topIndex) res = it;
    else break;
  }
  return res;
});

/** 派生：块索引（预览滚动同步用，需要块行界连续） */
export function indexOfLine(line: number): number {
  return blockIndexForLine(get(blocks$), line);
}

/** 启动：装载文档 + 全量解析（App onMount 调用一次）。
 * Wails 环境：先加载后端配置（含 localStorage 一次性迁移）、订阅文档事件，
 * 然后打开文档；无打开文档时回退本地草稿/示例。 */
export async function bootApp(): Promise<void> {
  if (booted) return;
  booted = true;

  let doc = "";
  let state: QuailDocState | null = null;
  try {
    // 先注册重放回调再加载配置：initSettings 装载完磁盘快照后会立即
    // 重放一次，各 store 才能在启动时拿到真实设置（而非兜底默认值）
    onConfigReplay(applyBackendConfig);
    await initSettings();
    subscribeFileEvents();
    // 启动文档由后端直接提交（命令行路径或空文档），前端不弹对话框
    state = await startupDoc();
  } catch (e) {
    console.warn("[boot] startupDoc failed, fallback to empty doc", e);
  }
  if (state) {
    doc = state.content;
    docState$.set(state);
  }
  doc$.set(doc);
  ready$.set(true);
  // ready 前的 doc$.set 不进入调度管线（订阅早退），ready 后补跑一次确保贯通；
  // 首次解析强制全量（worker 内部状态为空，语义等同全量重建）
  scheduleRebuild(get(doc$), true);
  // 初始化流程末尾统一调度 Ready（下一轮宏任务）：
  // 不等待编辑区/预览区渲染结束，窗口显示与首帧绘制并行推进。
  setTimeout(() => {
    void bridgeReady();
  }, 0);
}

/** 打开的文档状态（路径、编码等，供保存/标题/底部栏展示） */
export const docState$ = writable<QuailDocState | null>(null);

/** 订阅后端文档事件（外部修改 / 删除），只挂一次 */
let fileEventsBound = false;
function subscribeFileEvents(): void {
  if (fileEventsBound) return;
  fileEventsBound = true;
  void onBackendEvent("file:changed", (d: { path: string; content?: string }) => {
    if (typeof d?.content !== "string") return;
    docState$.update((s) => (s && s.path === d.path ? { ...s, content: d.content! } : s));
    // 未保存的本地修改不被外部改动静默覆盖：脏状态时仅提示
    if (get(dirty$)) {
      toast$.set({ id: Date.now(), msg: get(t)("toast.fileChangedDirty") });
    } else {
      doc$.set(d.content!);
      toast$.set({ id: Date.now(), msg: get(t)("toast.fileReloaded") });
    }
  });
  void onBackendEvent("file:deleted", (d: { path: string }) => {
    docState$.set(null);
    toast$.set({ id: Date.now(), msg: get(t)("toast.fileDeleted") });
  });
}

/** 后端配置快照 → 各 store（boot 与 config:changed 重放共用） */
export function applyBackendConfig(snap: Record<string, unknown>): void {
  const str = (k: string): string | undefined => (snap[k] == null ? undefined : String(snap[k]));
  const m = str("mode");
  if (m) mode$.set(m as Mode);
  const th = str("theme");
  if (th) theme$.set(th as ThemeId);
  const ind = str("indent");
  if (ind) indent$.set(ind as IndentId);
  const cm = str("countMode");
  if (cm) countMode$.set(cm as CountMode);
  const fe = str("fontEditor");
  if (fe != null) fontEditor$.set(fe);
  const fp = str("fontPreview");
  if (fp != null) fontPreview$.set(fp);
  const fse = snap["fontSizeEditor"];
  if (fse != null && Number.isFinite(Number(fse))) fontSizeEd$.set(Number(fse));
  const fsp = snap["fontSizePreview"];
  if (fsp != null && Number.isFinite(Number(fsp))) fontSizePv$.set(Number(fsp));
  const loc = str("locale");
  if (loc === "zh" || loc === "en") setLang(loc);
}
