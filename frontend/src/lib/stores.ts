/**
 * 全局状态中心：所有跨组件共享状态统一由 svelte store 持有。
 * - 持久化设置：persisted* 工厂在 store 创建时读入 localStorage，订阅期自动回写；
 * - AST 管线：doc$ 变化 → 防抖 → 增量解析 → root$/blocks$；派生大纲与字数统计；
 * - 组件私有交互细节（拖拽、程序滚动时间窗等）仍留在组件内，不在此处。
 */
import { writable, derived, get, type Writable } from "svelte/store";
import type { Root } from "mdast";
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
import { onBackendEvent, isWails, ready as bridgeReady, openDocument, type QuailDocState } from "./bridge";

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

/** 选区代理插件开关（默认启用） */
export const selectionProxy$ = persistedBool("md.selectionProxy", true);

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
export const blocks$ = writable<PreviewBlock[]>([]);
/** 解析时刻的源码快照：字数统计用它，避免每个按键重跑 */
export const parsedDoc$ = writable("");

/** 编辑器/预览 API 句柄（组件就绪后注入） */
export const editorApi$ = writable<EditorApi | null>(null);
/** 脏状态：当前文档与最近一次干净引用（初始化/保存时记录）不一致 */
export const dirty$ = writable(false);
export const previewApi$ = writable<PreviewApi | null>(null);

const parseState: IncrementalParseState = { src: "", root: null, blocks: [] };
let incCount = 0;
let parseTimer: ReturnType<typeof setTimeout> | undefined;
let idleFullTimer: ReturnType<typeof setTimeout> | undefined;

/** 全量/增量重建 AST（保留自愈校验制：块行界连续覆盖全文时跳过全量重算） */
export function rebuildAst(src: string, forceFull: boolean): void {
  const res = buildBlocksIncremental(parseState, src, forceFull);
  parseState.src = src;
  parseState.root = res.root;
  parseState.blocks = res.blocks;
  root$.set(res.root);
  blocks$.set(res.blocks);
  parsedDoc$.set(src);
}

let booted = false;

// doc$ 变化 → 500ms 防抖 → 增量解析（ready 后生效；idle 10s 自愈校验）
doc$.subscribe((src) => {
  if (!get(ready$)) return;
  clearTimeout(parseTimer);
  parseTimer = setTimeout(() => {
    incCount++;
    rebuildAst(src, incCount % 200 === 0);
    clearTimeout(idleFullTimer);
    idleFullTimer = setTimeout(() => {
      if (parseState.src !== get(doc$)) return;
      if (!blocksCoverDoc(parseState.blocks, parseState.src)) {
        rebuildAst(get(doc$), true);
      }
    }, 10000);
  }, 500);
});

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
export async function bootApp(loadDoc: () => Promise<string | null>): Promise<void> {
  if (booted) return;
  booted = true;

  let doc: string;
  let state: QuailDocState | null = null;
  if (isWails()) {
    await initSettings();
    onConfigReplay(applyBackendConfig);
    subscribeFileEvents();
    state = await openDocument().catch(() => null);
  }
  if (state) {
    doc = state.content;
  } else {
    let saved: string | null = null;
    try {
      saved = await loadDoc();
    } catch { /* 后端未接入时静默降级 */ }
    doc = saved ?? (await import("./sampleDoc")).buildSampleDoc();
  }
  doc$.set(doc);
  rebuildAst(doc, true);
  ready$.set(true);
  if (isWails()) {
    void bridgeReady(); // 首帧就绪 → 后端显示窗口
  }
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
  const sp = snap["selectionProxy"];
  if (sp != null) selectionProxy$.set(Boolean(sp));
  const loc = str("locale");
  if (loc === "zh" || loc === "en") setLang(loc);
}
