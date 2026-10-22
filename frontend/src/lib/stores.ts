/**
 * 全局状态中心：所有跨组件共享状态统一由 svelte store 持有。
 * - 持久化设置：persisted* 工厂在 store 创建时读入 settings 快照，订阅期自动回写；
 * - 解析管线（双 worker）：doc$ 变化 → 200ms 防抖（打开文档触发立即发送；
 *   IME 输入法组合期间永不发请求，内容积压到组合结束统一补跑）→ 增量 worker
 *   实时解析（段级补丁回传，未变段引用复用 → Svelte
 *   跳过子树）；例行周期全量重建由独立的重建 worker 并行执行（MessageChannel
 *   直连 + 内容哈希去重，基线在增量 worker 内原子替换，不经主线程、不阻塞
 *   打字响应）；冷启动/idle 自愈仍由增量 worker 就地全量；
 *   解析阶段由 parsePhase$ 对外报告（结果落地即 idle，无渐进挂载阶段）；
 * - 组件私有交互细节（拖拽、程序滚动时间窗等）仍留在组件内，不在此处。
 */
import { writable, derived, get, type Writable } from "svelte/store";
import type {
  Mode,
  DefaultLayout,
  ThemeId,
  IndentId,
  CountMode,
  OutlineItem,
  ParsePhase,
  ParseContext,
  PreviewApi,
  PreviewBlock,
} from "./types";
import type { EditorApi } from "./editor/codemirrorSetup";
import { blockIndexForLine } from "./markdown";
import type { HastSegment } from "./markdown/markdown-core";
import { createParseClient } from "./worker/parse-client";
import { t, locale, setLang } from "./i18n.svelte";
import { kvGet, kvSet, onConfigReplay, initSettings } from "./settings";
import { onBackendEvent, openDocument, ready as bridgeReady, saveAsViaDialog, startupDoc, type QuailDocState } from "./bridge";
import { splitSavePath, isValidMode } from "./docpath";
import { banner$ } from "./banner";
import { resetHighlightWorker } from "./highlight/hl-client";

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

/**
 * 启动时的默认布局：
 * - memory：记住上次的布局（mode 持久化，即历史行为）；
 * - source / split / preview：每次启动固定使用指定布局（见 bootApp）。
 * 仅在启动时生效，运行中切换布局始终自由、不回写本设置。
 */
export const defaultLayout$ = persistedEnum<DefaultLayout>(
  "md.defaultLayout",
  "memory",
  ["memory", "source", "split", "preview"] as const
);

export const theme$ = persistedEnum<ThemeId>(
  "md.theme",
  "ayu-dark",
  [
    "ayu-dark",
    "ayu-mirage",
    "ayu-light",
    "one-dark-pro",
    "dracula",
    "nord",
    "tokyo-night",
    "github-light",
    "github-dark",
    "solarized-light",
    "catppuccin-mocha",
    "catppuccin-latte",
    "rose-pine",
    "gruvbox-dark",
    "gruvbox-light",
    "night-owl",
    "palenight",
    "monokai-pro",
    "material-theme",
    "vitesse-dark",
    "vitesse-light",
    "everforest-dark",
    "everforest-light",
    "one-light",
    "alabaster",
  ] as const
);

export const indent$ = persistedEnum<IndentId>("md.indent", "space2", ["tab", "space2", "space4"] as const);

/** 字数统计方式：character（字符）/ word（单词）/ hybrid（字词，单位随界面语言） */
export const countMode$ = persistedEnum<CountMode>("md.countMode", "hybrid", ["character", "word", "hybrid"] as const);

/** 编辑区/预览区字体（空值 = 使用回退链默认值） */
export const fontEditor$ = persistedText("md.fontEditor", "");
export const fontPreview$ = persistedText("md.fontPreview", "");

/** 编辑区/预览区字号（px） */
export const fontSizeEd$ = persistedNumber("md.fontSizeEd", 15);
export const fontSizePv$ = persistedNumber("md.fontSizePv", 15.5);

/* ---------------- UI 状态 ---------------- */

export const settingsOpen$ = writable(false);
/** 设置面板二级页面：null = 一级页面；"theme" = 主题；"licenses" = 开源许可 */
export const settingsSubPage$ = writable<null | "theme" | "licenses">(null);
export const outlineOpen$ = writable(false);
/** 大纲追踪激活项：滚动同步（自动切换）时为 true；点击跳转后为 false */
export const outlineAutoTrack$ = writable(true);
export const topIndex$ = writable(0);

/** toast：{id, msg}（id 驱动重置自动关闭计时） */
export const toast$ = writable<{ id: number; msg: string } | null>(null);

/* ---------------- 解析管线（worker 承载） ---------------- */

/** 编辑器文档（保存走后端，不落本地存储） */
export const doc$ = writable("");

export const ready$ = writable(false);

/**
 * 预览段列表（worker splitSegments 的结果；渲染层数据源）。
 * 增量更新为段级 splice：未变段对象引用保持稳定 →
 * MarkdownNode 按 props 引用相等跳过子树（图片不重新请求）。
 */
export const segments$ = writable<HastSegment[]>([]);
/**
 * 全量重建纪元（renderEpoch$）与渐进渲染进度（renderTotal$/renderProgress$）
 * 已随渐进式渲染一起移除：虚拟化预览按需挂载，全量/增量结果直接落地
 * segments$，无需主线程重放窗口；parsePhase$ 只区分 parsing / idle。
 */
export const blocks$ = writable<PreviewBlock[]>([]);
/** 大纲（worker 由 mdast + blocks 计算后回传） */
export const outline$ = writable<OutlineItem[]>([]);
/** 字数统计（worker 按解析时刻源码快照计算后回传，主线程不再扫全文） */
export const counts$ = writable<{ chars: number; words: number; hybrid: number }>({ chars: 0, words: 0, hybrid: 0 });

/** 预览解析阶段：parsing（worker 解析中）→ idle（结果落地即收敛，无渐进挂载阶段） */
export const parsePhase$ = writable<ParsePhase>("idle");

/**
 * 最近一次解析的触发上下文（底栏解析状态指示器区分展示规则用）：
 * open / blank-open / edit，语义见 types.ts 的 ParseContext 注释。
 * 由调度器在发送解析请求时写入（markNextParseAsOpen 标记打开文档触发）。
 */
export const parseContext$ = writable<ParseContext>("edit");

/** 编辑器/预览 API 句柄（组件就绪后注入） */
export const editorApi$ = writable<EditorApi | null>(null);
/** 脏状态：当前文档与最近一次干净引用（初始化/保存时记录）不一致 */
export const dirty$ = writable(false);
export const previewApi$ = writable<PreviewApi | null>(null);

/* ---------------- 解析调度：200ms 防抖 + IME 组合闸门 + worker 背压 ----------------
 * - 防抖：文档变化后静默 PARSE_DEBOUNCE_MS 才发起解析请求，连续输入
 *   （打字、粘贴、连续撤销）只解析最终内容，不逐次发请求；
 * - 打开文档触发（markNextParseAsOpen）跳过防抖立即发送，保证首屏即时；
 * - IME 输入法组合期间（compositionstart → compositionend，CM6 经
 *   setImeComposing 上报）永不发起请求：组合中的临时文本不进预览，
 *   内容只记入积压，组合结束后重新起防抖统一补跑；
 * - worker 在途时积压最新 src，响应回齐后重新起防抖补跑（worker 串行处理，
 *   乱序发送会让增量补丁相对 worker 内部状态错位，故必须背压）。 */
const PARSE_DEBOUNCE_MS = 200;

let pendingSrc: string | null = null;
let pendingForceFull = false;
let pending = false;
/** 与 pendingSrc 同生命周期的「打开文档触发」标记（调度时并入，flushNow 消费） */
let pendingOpen = false;
/** 待生效的「打开文档触发」单次标记（markNextParseAsOpen 置位，下次调度消费） */
let nextParseIsOpen = false;
/** 防抖定时器（undefined = 无待触发的 flush） */
let debounceTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * 输入法组合状态（CM6 compositionstart/compositionend 经 setImeComposing 上报）。
 * 组合期间调度器只积压内容、永不发起解析请求（flush 也会被闸门拦下）。
 */
export const imeComposing$ = writable(false);

/** 上报输入法组合开始/结束（CM6 dom 事件）。结束时若有积压且无闸门 → 重新起防抖补跑 */
export function setImeComposing(composing: boolean): void {
  imeComposing$.set(composing);
  if (!composing) resumeParseScheduling();
}

/** 重新起防抖（组合结束 / worker 回齐后共用）：有积压、无在途、未在组合中才生效 */
function resumeParseScheduling(): void {
  if (debounceTimer !== undefined) return;
  if (!pending || pendingSrc === null) return;
  if (get(imeComposing$) || parseClient.busy()) return;
  armDebounce();
}

function armDebounce(): void {
  if (debounceTimer !== undefined) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(flushNow, PARSE_DEBOUNCE_MS);
}

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
      // 冷启动首批：整列表重建（渲染层为 keyed 原地 diff + 虚拟化按需挂载，
      // 无需纪元/重放机制；未变段引用复用，图片不重新请求）
      fullBatchBuffer = null;
      segments$.set(msg.items);
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
      // 图片不重新请求；虚拟化按需挂载，长列表直接落地）
      if (fullBatchBuffer !== null) {
        segments$.set(fullBatchBuffer);
        fullBatchBuffer = null;
      }
    } else {
      // 增量：只 splice 被替换区间（未变段引用不变 → Svelte 跳过对应子树）
      const { segStart, segCount, items } = msg.segments;
      segments$.update((arr) => {
        const next = arr.slice();
        next.splice(segStart, segCount, ...items);
        return next;
      });
    }
    // 无渐进挂载阶段：结果落地即收敛（底栏转圈仅覆盖 worker 解析窗口）
    parsePhase$.set("idle");
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

/** worker 响应回齐后的积压补跑（无在途、有积压 → 重新起防抖） */
function onWorkerDrained(): void {
  if (parseClient.busy()) return;
  resumeParseScheduling();
}

/** 标记下一次调度到的解析为「打开文档」触发（bootApp 装载 / 磁盘文件重载时调用）。
 * 打开触发的解析无「解析中」显示阈值（底栏指示器语义，见 ParseContext.open）。 */
export function markNextParseAsOpen(): void {
  nextParseIsOpen = true;
}

/** 调度一次解析：200ms 防抖（打开触发立即发送；IME 组合中只积压不发送） */
function scheduleRebuild(src: string, forceFull = false): void {
  pendingSrc = src;
  pendingForceFull = forceFull;
  // 单次「打开文档」标记并入本次待发送请求（多次标记取或；无请求时留待下次调度）
  pendingOpen = pendingOpen || nextParseIsOpen;
  nextParseIsOpen = false;
  if (pending) return; // 已有待发送：防抖语义，等最后一次变化后统一解析
  pending = true;
  // IME 组合中：永不发起请求（内容已记入积压），组合结束后统一补跑
  if (get(imeComposing$)) return;
  // 打开文档触发：跳过防抖立即发送（首屏即时，指示器同步进入解析中）
  if (pendingOpen) {
    flushNow();
    return;
  }
  armDebounce();
}

/** 消费 pendingSrc 并发送解析请求（防抖定时器到期 / 打开触发直调） */
function flushNow(): void {
  debounceTimer = undefined;
  // IME 组合闸门：组合中永不发起请求；保留积压，组合结束后重新起防抖
  if (get(imeComposing$)) return;
  if (parseClient.busy()) return; // worker 在途：响应回齐后 onWorkerDrained 补跑
  pending = false;
  const s = pendingSrc;
  const ff = pendingForceFull;
  pendingSrc = null;
  pendingForceFull = false;
  if (s === null) return;
  // 消费「打开文档」标记，写入本次解析的触发上下文（空白文档打开 → blank-open）
  const openNow = pendingOpen;
  pendingOpen = false;
  // 空白文档（打开空白文档 / 编辑清空）：解析是无用功 → 不发 worker 请求，
  // 主线程直接落地空结果，仅同步 worker 内部状态为干净空基线（不解析不回包）。
  // root 归零后下一次真实解析按冷启动全量走，例行重建的旧基线也会被 src 守卫丢弃。
  if (s.trim() === "") {
    fullBatchBuffer = null;
    parseClient.resetEmpty();
    segments$.set([]);
    blocks$.set([]);
    outline$.set([]);
    counts$.set({ chars: 0, words: 0, hybrid: 0 });
    parseContext$.set(openNow ? "blank-open" : "edit");
    if (openNow) {
      // 打开空白文档 → 指示器切「准备就绪」：合成一对 parsing/idle 相位事件
      // 驱动组件状态机（组件对 blank-open 不记统计、不出转圈）
      parsePhase$.set("parsing");
      parsePhase$.set("idle");
    }
    return;
  }
  parseContext$.set(openNow ? "open" : "edit");
  parsePhase$.set("parsing");
  parseClient.request(s, ff);
}

// doc$ 变化 → 记 pendingSrc → 200ms 防抖（ready 后生效；全量阈值/idle 自愈在 worker 内）
doc$.subscribe((src) => {
  if (!get(ready$)) return;
  scheduleRebuild(src);
});

let booted = false;


/** 派生：字数统计标签（worker 回传的解析快照统计，主线程不扫全文）。
 * 字词（hybrid）的显示单位跟随界面语言：中文始终「字」、西文始终「词」。 */
export const countLabel$ = derived(
  [counts$, countMode$, locale, t],
  ([counts, mode, lang, tt]) => {
    const n =
      mode === "character" ? counts.chars
      : mode === "word" ? counts.words
      : counts.hybrid;
    const unit =
      mode === "character" ? tt("stats.chars")
      : mode === "word" ? tt("stats.words")
      : lang === "zh" ? tt("stats.chars") : tt("stats.words");
    return `${n.toLocaleString()} ${unit}`;
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
 * Wails 环境：先加载后端配置、订阅文档事件，
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
    // 启动时应用布局：
    // - defaultLayout 指定具体布局 → 固定使用该布局；
    // - memory（默认）→ 读取持久化的 mode（上次布局）。
    // 运行中其他窗口保存的 mode 不实时重放（见 applyBackendConfig），
    // 只有新打开的窗口才会读到。
    const layout = kvGet("md.defaultLayout");
    if (layout === "source" || layout === "split" || layout === "preview") {
      mode$.set(layout as Mode);
    } else {
      const savedMode = kvGet("md.mode");
      if (savedMode != null && isValidMode(savedMode)) mode$.set(savedMode);
    }
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
  // 打开文档触发：指示器按 open / blank-open 语义展示
  markNextParseAsOpen();
  scheduleRebuild(get(doc$), true);
  // 初始化流程末尾统一调度 Ready（下一轮宏任务）：
  // 不等待编辑区/预览区渲染结束，窗口显示与首帧绘制并行推进。
  setTimeout(() => {
    void bridgeReady();
  }, 0);
}

/** 打开的文档状态（路径、编码等，供保存/标题/底部栏展示） */
export const docState$ = writable<QuailDocState | null>(null);

/**
 * 守卫用脏状态：退出/打开替换等确认拦截的实际依据。
 * 与所有文档统一口径：内容与干净基线不一致即拦截（文件被删除后未编辑
 * 则内容仍与基线一致 → 不拦截，可直接退出/另存；未命名文档不再特殊
 * 处理，其唯一差异保留在保存路径——无路径文档保存始终走另存为）。
 */
export const guardDirty$ = derived(dirty$, (d) => d);

/* ------------- 打开 / 另存 / 横幅重新加载（App 与横幅事件共用） ------------- */

/**
 * 装载已打开的文档状态（原地打开通道：未命名空白文档打开 / 横幅重新加载）。
 * 打开文档语义：指示器立即进入「解析中」（无 200ms 阈值，空白文档除外）。
 */
export function loadOpenedDoc(state: QuailDocState): void {
  markNextParseAsOpen();
  docState$.set(state);
  doc$.set(state.content);
  get(editorApi$)?.setDoc(state.content);
}

/** 另存为（Wails 原生保存对话框 → FileService.SaveAs） */
export async function saveFileAs(): Promise<void> {
  // 对话框默认文件名跟随界面语言（后端不做 i18n）
  const res = await saveAsViaDialog(get(doc$), `${get(t)("doc.untitled")}.md`);
  if (res?.ok) {
    // dir/name 优先用后端按平台规范填充的字段（Windows 反斜杠路径由
    // filepath 解析）；后端字段缺失时前端兜底按 / 与 \ 双分隔符切分
    const parsed = splitSavePath(res.path);
    docState$.set({
      path: res.path,
      dir: res.dir || parsed.dir,
      name: res.name || parsed.name,
      content: get(doc$),
      encoding: "utf-8",
      size: 0,
      modTime: 0,
    });
    get(editorApi$)?.markClean();
  }
}

/**
 * 横幅「重新加载」第一步：重置编辑区、预览区、文档相关状态，并把三个
 * worker（增量解析 / 例行重建 / 着色）内部状态归零；随后由调用方走当前
 * 实例打开操作。大纲过滤关键词（OutlinePanel 组件内状态）与 CM6 查找
 * 搜索面板状态保持不变（组件不卸载、面板不重配置）。
 */
function resetDocRuntime(): void {
  // 文档状态清零（打开操作重新装载），脏/编辑记录复位
  docState$.set(null);
  dirty$.set(false);
  // 预览区：滚动位置与滚动同步状态归零（新内容从顶部开始）；
  // 解析产物即时落空（不等防抖：重新加载应立刻清掉旧文档的预览）
  topIndex$.set(0);
  outlineAutoTrack$.set(true);
  get(previewApi$)?.setScrollTop(0);
  fullBatchBuffer = null;
  segments$.set([]);
  blocks$.set([]);
  outline$.set([]);
  counts$.set({ chars: 0, words: 0, hybrid: 0 });
  // 编辑区：整体替换为空文档（setDoc 清撤销历史并记干净基线）；
  // doc$ 调度随后走空白重置路径，与 worker 归零语义对齐
  doc$.set("");
  get(editorApi$)?.setDoc("");
  // 三个 worker 内部状态归零：
  // - 增量解析 worker：解析基线清空（下一次解析冷启动全量）
  // - 例行重建 worker：内容哈希缓存清空（同内容也强制重建）
  // - 着色 worker：热缓存与 in-flight 表清空
  parseClient.reset();
  resetHighlightWorker();
}

/**
 * 横幅「重新加载」：重置编辑区/预览区/文档相关状态与三个 worker 内部
 * 状态，然后走当前实例打开操作（Open 重读磁盘 + loadOpenedDoc 装载，
 * 与空白文档打开新文档同一操作）。打开失败仅提示（重置后的空白状态
 * 保持，可再次打开或另选文件）。
 */
async function reloadDocumentFromDisk(path: string): Promise<void> {
  resetDocRuntime();
  try {
    const state = await openDocument(path);
    if (state) loadOpenedDoc(state); // null = 二进制文件，静默丢弃
  } catch {
    toast$.set({ id: Date.now(), msg: get(t)("toast.openFailed") });
  }
}

/** 订阅后端文档事件（外部修改 / 删除），只挂一次 */
let fileEventsBound = false;
function subscribeFileEvents(): void {
  if (fileEventsBound) return;
  fileEventsBound = true;
  void onBackendEvent("file:changed", (d: { path: string; content?: string }) => {
    if (typeof d?.content !== "string") return;
    // 文件重新出现在磁盘（如删除后又被外部恢复/重建）：解除 deleted 标记，
    // 同步磁盘内容快照（展示用；重新加载以打开操作从磁盘重读为准）
    docState$.update((s) =>
      s && s.path === d.path ? { ...s, content: d.content!, deleted: false } : s
    );
    // 外部修改 → 横幅提示：不再静默重载（会丢弃本地未保存修改），也
    // 不再按脏状态区分 TOAST——统一由用户显式选择「重新加载 / 忽略」
    banner$.set({
      kind: "modified",
      path: d.path,
      onPrimary: () => void reloadDocumentFromDisk(d.path),
    });
  });
  void onBackendEvent("file:deleted", (d: { path: string }) => {
    // 文件被外部移动/删除：保留路径并标记 deleted，内容与脏状态维持
    // 删除前的值（未编辑则仍可直接退出/另存；保存路由到确认重建流程）。
    // 当前未命名文档（无路径）时删除事件不适用，保持原状。
    docState$.update((s) => (s && s.path === d.path ? { ...s, deleted: true } : s));
    // 原 TOAST 响应取消：改为横幅提示（另存为 / 忽略）
    banner$.set({
      kind: "deleted",
      path: d.path,
      onPrimary: () => void saveFileAs(),
    });
  });
}

/** 后端配置快照 → 各 store（boot 与 config:changed 重放共用） */
export function applyBackendConfig(snap: Record<string, unknown>): void {
  const str = (k: string): string | undefined => (snap[k] == null ? undefined : String(snap[k]));
  // mode 不在运行时重放：布局是窗口本地状态，其他窗口保存的 mode
  // 只作为启动默认值（见 bootApp），不回推正在运行的窗口。
  // 注意 snapshot 仍会同步该字段（settings.ts 的 config:changed），
  // 以保持事实源一致与脏字段比较正确。
  // const m = str("mode");
  // if (isValidMode(m)) mode$.set(m);
  const dl = str("defaultLayout");
  // 校验后再回放：旧配置文件可能残留非法值
  if (dl === "memory" || dl === "source" || dl === "split" || dl === "preview") {
    defaultLayout$.set(dl);
  }
  const th = str("theme");
  if (th) theme$.set(th as ThemeId);
  const ind = str("indent");
  // 校验后再回放：旧配置文件可能残留非法值（如早期后端默认 "2"），
  // 直接写入会让 CM6 缩进配置拿到 undefined
  if (ind === "tab" || ind === "space2" || ind === "space4") indent$.set(ind);
  const cm = str("countMode");
  // 旧配置迁移：auto（跟随语言）→ hybrid；chars → character；words → word；
  // 非法值不回放（保持默认 hybrid）
  if (cm === "character" || cm === "word" || cm === "hybrid") {
    countMode$.set(cm);
  } else if (cm === "auto" || cm === "chars" || cm === "words") {
    countMode$.set(cm === "auto" ? "hybrid" : cm === "chars" ? "character" : "word");
  }
  const fe = str("fontEditor");
  if (fe != null) fontEditor$.set(fe);
  const fp = str("fontPreview");
  if (fp != null) fontPreview$.set(fp);
  const fse = snap["fontSizeEditor"];
  if (fse != null && Number.isFinite(Number(fse))) fontSizeEd$.set(Number(fse));
  const fsp = snap["fontSizePreview"];
  if (fsp != null && Number.isFinite(Number(fsp))) fontSizePv$.set(Number(fsp));
  const loc = str("locale");
  // 校验后再回放：旧配置文件可能残留非法值（非法值由 setLang 归一化为跟随系统）
  if (loc === "system" || loc === "zh" || loc === "en") setLang(loc);
}
