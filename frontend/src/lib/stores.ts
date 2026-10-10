/**
 * 全局状态中心：所有跨组件共享状态统一由 svelte store 持有。
 * - 持久化设置：persisted* 工厂在 store 创建时读入 localStorage，订阅期自动回写；
 * - AST 管线：doc$ 变化 → rAF 合并 + 自适应 minInterval + 120ms maxWait → 增量解析
 *   → root$/hast$/blocks$（HAST 未变段复用节点引用）；派生大纲与字数统计；
 * - 组件私有交互细节（拖拽、程序滚动时间窗等）仍留在组件内，不在此处。
 */
import { writable, derived, get, type Writable } from "svelte/store";
import type { Root } from "mdast";
import type { Root as HastRoot } from "hast";
import type {
  Mode,
  ThemeId,
  IndentId,
  CountMode,
  OutlineItem,
  PreviewApi,
  PreviewBlock,
} from "./types";
import type { EditorApi } from "./editor/codemirrorSetup";
import {
  buildBlocksIncremental,
  buildOutline,
  blockIndexForLine,
  countEnglishWords,
  countHanCharacters,
  blocksCoverDoc,
  type IncrementalParseState,
} from "./markdown";
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

/* ---------------- AST 管线 ---------------- */

/** 编辑器文档（保存走后端，不落 localStorage） */
export const doc$ = writable("");

export const ready$ = writable(false);

/** 解析结果（整体替换、只读消费；store 值无深度代理，性能等同 $state.raw） */
export const root$ = writable<Root | null>(null);
/** HAST 根：渲染层数据源（MarkdownRenderer 组件树直渲染，不经 HTML 字符串） */
export const hast$ = writable<HastRoot | null>(null);
export const blocks$ = writable<PreviewBlock[]>([]);
/** 解析时刻的源码快照：字数统计用它，避免每个按键重跑 */
export const parsedDoc$ = writable("");

/** 编辑器/预览 API 句柄（组件就绪后注入） */
export const editorApi$ = writable<EditorApi | null>(null);
/** 脏状态：当前文档与最近一次干净引用（初始化/保存时记录）不一致 */
export const dirty$ = writable(false);
export const previewApi$ = writable<PreviewApi | null>(null);

const parseState: IncrementalParseState = { src: "", root: null, hast: null, blocks: [] };

/* ---------------- 解析调度：rAF 合并 + 自适应 minInterval + maxWait ----------------
 * 相比固定 500ms 防抖：输入流畅时下一帧即解析（预览延迟 500ms → ~16ms），
 * 高频全量替换时自适应拉长 minInterval 节流；maxWait 兜底防“永远没空档”。 */
const MIN_INTERVAL_BASE = 16;
const ADAPT_STEP = 32;
const MAX_INTERVAL = 256;
const MAX_WAIT = 120;
const HEAL_DELAY = 10000;

let minInterval = MIN_INTERVAL_BASE;
let lastRun = 0;
let pendingSrc: string | null = null;
let pending = false;
let adaptHits = 0;
let flushRaf: number | undefined;
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let healTimer: ReturnType<typeof setTimeout> | undefined;

/** 全量/增量重建 AST（保留自愈校验制：块行界连续覆盖全文时跳过全量重算） */
export function rebuildAst(src: string, forceFull: boolean): void {
  const res = buildBlocksIncremental(parseState, src, forceFull);
  parseState.src = src;
  parseState.root = res.root;
  parseState.hast = res.hast;
  parseState.blocks = res.blocks;
  parseState.incrementalCount = res.incrementalCount; // 全量阈值归属 markdown.ts
  root$.set(res.root);
  // 增量路径的 hast 已复用 head/tail 段节点引用 → 渲染层按引用跳过未变子树
  hast$.set(res.hast);
  blocks$.set(res.blocks);
  parsedDoc$.set(src);
}

/** 10s idle 自愈：文档静止后校验块行界无缝覆盖，失败则全量重算（兜底防御） */
function scheduleHealCheck(): void {
  clearTimeout(healTimer);
  healTimer = setTimeout(() => {
    healTimer = undefined;
    if (parseState.src !== get(doc$)) return; // 已有新编辑在途，让位
    if (!blocksCoverDoc(parseState.blocks, parseState.src)) {
      rebuildAst(get(doc$), true);
    }
  }, HEAL_DELAY);
}

function runRebuild(src: string): void {
  rebuildAst(src, false); // forceFull 恒 false：全量阈值只归 markdown.ts 的 incrementalCount
  scheduleHealCheck();
}

/** 高频触发（在途时又来新 src）计数：连续 ≥3 次 → 拉长 minInterval */
function noteAdapt(): void {
  adaptHits++;
  if (adaptHits >= 3) {
    minInterval = Math.min(MAX_INTERVAL, minInterval + ADAPT_STEP);
  }
}

/** 调度一次解析：rAF 快路径（无背压）+ minInterval 节流 + MAX_WAIT 强制兜底 */
function scheduleRebuild(src: string): void {
  pendingSrc = src;
  if (pending) {
    noteAdapt();
    return;
  }
  pending = true;
  adaptHits = 0;
  const since = performance.now() - lastRun;
  const delay = Math.max(0, minInterval - since);
  if (delay < MIN_INTERVAL_BASE) {
    // 快路径：下一帧解析；MAX_WAIT 双保险（rAF 被后台节流时仍按时解析）
    flushRaf = requestAnimationFrame(flushNow);
    flushTimer = setTimeout(flushNow, MAX_WAIT);
  } else {
    // 背压：minInterval 内刚跑过 → 最多再等 MAX_WAIT
    flushTimer = setTimeout(flushNow, Math.min(delay, MAX_WAIT));
  }
}

/** 消费 pendingSrc 并解析（rAF/timer 竞争，单线程下先到先清） */
function flushNow(): void {
  flushRaf = undefined;
  clearTimeout(flushTimer);
  flushTimer = undefined;
  pending = false;
  const s = pendingSrc;
  pendingSrc = null;
  if (s === null) return;
  lastRun = performance.now();
  runRebuild(s);
  // 本轮无高频触发 → 向基准回落
  if (adaptHits === 0) {
    minInterval = Math.max(MIN_INTERVAL_BASE, minInterval - ADAPT_STEP);
  }
}

// doc$ 变化 → 记 pendingSrc → rAF 合并（ready 后生效；全量阈值/idle 自愈见上）
doc$.subscribe((src) => {
  if (!get(ready$)) return;
  scheduleRebuild(src);
});

let booted = false;


/** 派生：大纲（mdast 标题 + 行号映射到 HAST 块） */
export const outline$ = derived([root$, blocks$], ([root, blocks]) =>
  root && blocks ? buildOutline(root, blocks) : []
);

/** 派生：字数统计生效模式（auto 跟随界面语言） */
export const effectiveCountMode$ = derived([countMode$, locale], ([m, lang]) =>
  m === "auto" ? (lang === "zh" ? "chars" : "words") : m
);

/** 派生：字数统计标签（跟随解析快照，避免按键即扫全文） */
export const countLabel$ = derived(
  [parsedDoc$, effectiveCountMode$, t],
  ([parsed, mode, tt]) => {
    if (mode === "chars") {
      return `${countHanCharacters(parsed).toLocaleString()} ${tt("stats.chars")}`;
    }
    return `${countEnglishWords(parsed).toLocaleString()} ${tt("stats.words")}`;
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
  rebuildAst(doc, true);
  ready$.set(true);
  // ready 前的 doc$.set 不进入调度管线（订阅早退），ready 后补跑一次确保贯通
  scheduleRebuild(get(doc$));
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
