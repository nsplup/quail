/**
 * Markdown 增量解析 worker：主线程之外承接实时解析链路
 * （parseMarkdown → mdastToHastRaw → splitSegments / blocks / outline / counts）。
 *
 * DOM shim（linkedom）：
 * - worker 全局没有 document/window；为隔离「传递依赖引用 DOM 全局」的
 *   报错（历史上 rehype-raw 链路曾触发 document 未定义），入口处在任何
 *   解析库 import 之前建立轻量 DOM shim（linkedom 仅打包进 worker chunk，
 *   主 bundle 零增量）。shim 只覆盖最小集合，供异常路径兜底，正常解析
 *   （parse5 纯 JS 实现）不会触达 DOM。
 * - 注意：shim 赋值必须在解析库 import 之前完成模块求值顺序——本文件
 *   顶部 import 与下方赋值均为模块顶层代码，ESM import 先于赋值求值，
 *   因此 shim 单独放在独立模块（dom-shim.ts）并置于首个 import 位。
 *
 * 职责（与全量重建 worker 分工，见 full.worker.ts）：
 * - 维护 IncrementalParseState（src/root/hast/blocks），按消息到达顺序串行
 *   增量解析，实时响应编辑（打字延迟 = 一帧 + 单次增量解析耗时）；
 * - 增量：段级补丁（只回传被替换区间；未变段不重发，保住主线程引用复用）；
 * - 就地全量（会短暂阻塞增量请求，仅用于可感知性低的场景）：冷启动
 *   （boot / 崩溃重建）、主线程强制、10s idle 自愈校验失败（此时用户已
 *   停止输入）；段列表分批回传（FullBatch）+ 最终汇总（ParseResult full=true）；
 * - 例行周期全量：连续增量达到 SELF_HEAL_EVERY 阈值时，不就地解析，而是
 *   携带内容哈希向独立的重建 worker 发请求；重建基线回来后校验 src 未漂移
 *   → 原子替换持有的旧 HAST（引用赋值，主线程零感知）；若基线块列表与
 *   当前不一致（增量启发式发生过漂移）则顺带把校正后的段列表分批回传主线程；
 * - 异常：postMessage(WorkerError)，主线程负责重建 worker。
 */
import "./dom-shim";

import {
  buildBlocksIncremental,
  buildOutline,
  splitSegments,
  blocksCoverDoc,
  countTextAs,
  splitLines,
  SELF_HEAL_EVERY,
  type IncrementalParseState,
  type SegmentPatchRange,
} from "../markdown/markdown-core";
import type { Root as MdastRoot } from "mdast";
import { contentHash } from "./contentHash";
import type { HastSegment } from "../markdown/markdown-core";
import type { CountMode, PreviewBlock } from "../types";
import type {
  Counts,
  RebuildPortOut,
  RebuildRequestMsg,
  WorkerIn,
  WorkerOut,
} from "./protocol";

/** 全量段列表的单批段数：控制单条消息体积 */
const FULL_BATCH_SEGMENTS = 256;
/** idle 自愈延时：与原主线程调度器一致 */
const HEAL_DELAY_MS = 10000;

/** 解析状态（worker 内部持有，随消息串行演进） */
const state: IncrementalParseState = {
  src: "",
  root: null,
  hast: null,
  blocks: [],
  incrementalCount: 0,
};

let healTimer: ReturnType<typeof setTimeout> | undefined;
/** 与重建 worker 直连的 port（主线程经 initRebuildPort 移交；重建 worker 重连时更换） */
let rebuildPort: MessagePort | null = null;
/** 重建请求在途标志：阈值倍数可能在一轮重建期间被多次越过，去重防刷 */
let rebuildInFlight = false;

/* ---------------- 字数统计（单口径 + 内容哈希缓存 + 块级增量） ----------------
 *
 * 三种统计口径已在 blocks.ts 解耦（countTextAs 只算指定口径），本模块负责：
 * - 只统计当前口径 countMode（主线程 setCountMode 切换）——不再像旧
 *   countText 一样每次解析对全文分段算出三种口径；
 * - 内容哈希|口径 → 统计值缓存：切换口径时同内容同口径直接命中回传，
 *   未命中才重算，重算结果回填缓存（容量有限，防长会话无界增长）；
 * - 增量处理：维护「块级计数基线」——预览块无缝覆盖全文（blocksCoverDoc
 *   不变量），全文 = 块文本以 "\n" 连接，三种口径在块间可加（字符口径
 *   的块间分隔 "\n" 各计 1 个 grapheme，见 blocks.ts 可加性约定）。
 *   增量解析复用其输入（被替换块区间 + 新块行界），只对被替换块及
 *   邻接块重算，基线 splice 后求和：编辑热路径的统计从「全文分段」
 *   降为「局部 chunk 分段」。
 */

/** 当前字数统计口径（主线程 setCountMode 切换；默认与设置默认值一致） */
let countMode: CountMode = "hybrid";

/** 内容哈希|口径 → 统计值缓存：切换口径时未变内容的重算直接命中 */
const countCache = new Map<string, number>();
/** 缓存容量上限：编辑不断产生新内容哈希，容量防无界增长（淘汰最旧） */
const COUNT_CACHE_CAP = 8;

/** 块级计数基线：与 state.blocks 下标对齐、口径为 countMode 的每块统计值。
 * null = 基线不可用（口径刚切换待惰性重建 / 全量路径外未建 / 块未覆盖全文），
 * 下一次解析退回全量重算（结果照常回填）。 */
let blockCounts: number[] | null = null;

function cacheKey(hash: string, mode: CountMode): string {
  return hash + "|" + mode;
}

function cachePut(key: string, value: number): void {
  // 删除后重插挪到最新：命中即续期（简单 LRU 语义）
  countCache.delete(key);
  countCache.set(key, value);
  while (countCache.size > COUNT_CACHE_CAP) {
    const oldest = countCache.keys().next();
    if (oldest.done) break;
    countCache.delete(oldest.value);
  }
}

/** 从源码行数组提取块的源码文本。行数组必须来自 splitLines（与锚点行号
 * 同语义）；其中行内容已不含行尾 "\r"（\r 已作为换行分隔被消费），
 * 行尾 "\r" 剥除仅作防御保留。 */
function blockTextFromLines(lines: string[], b: PreviewBlock): string {
  let text = "";
  for (let i = b.startLine - 1; i < b.endLine; i++) {
    // 非首行补 "\n" 连接符（不能用 text !== "" 判断：块首行可能本身为空行）
    if (i > b.startLine - 1) text += "\n";
    const line = lines[i] ?? "";
    text += line.endsWith("\r") ? line.slice(0, -1) : line;
  }
  return text;
}

/** 块级基线 → 全文统计值：块间 "\n" 分隔符在字符口径各计 1 个 grapheme
 * （全文 = 块文本以 "\n" 连接；单词 / 字词口径下分隔符不计，贡献为 0） */
function totalFromBaseline(bc: number[], mode: CountMode): number {
  let sum = 0;
  for (let i = 0; i < bc.length; i++) sum += bc[i];
  if (mode === "character" && bc.length > 1) sum += bc.length - 1;
  return sum;
}

/** 全量口径统计（基线重建 / 口径切换重算共用）：块无缝覆盖全文 → 逐块
 * 统计并建基线（后续增量补丁依赖）；覆盖不变量不成立（空白文档 / 漂移
 * 瞬间）→ 退回全文一次分段，不建基线。CRLF 归一与块文本提取口径一致。 */
function computeCounts(
  src: string,
  blocks: PreviewBlock[],
  mode: CountMode
): { value: number; baseline: number[] | null } {
  if (blocks.length > 0 && blocksCoverDoc(blocks, src)) {
    const lines = splitLines(src);
    const baseline: number[] = new Array(blocks.length);
    for (let i = 0; i < blocks.length; i++) {
      baseline[i] = countTextAs(blockTextFromLines(lines, blocks[i]), mode);
    }
    return { value: totalFromBaseline(baseline, mode), baseline };
  }
  // 覆盖不变量不成立（理论只在漂移瞬间出现）：退回全文统计，不建基线。
  // 归一口径与块文本提取一致（\r\n/\r 均归一为 "\n"，与 splitLines 行语义
  // 对齐），保证两条路径统计结果可互逆。
  return {
    value: countTextAs(src.replace(/\r\n?/g, "\n"), mode),
    baseline: null,
  };
}

/** 增量解析结果 → 块级基线补丁更新：复用增量解析的输入（被替换块区间 +
 * 新块行界），只重算被替换块与邻接块，未变块不重新分段。
 * 邻接块重算的原因：增量解析会调整 head 末块的 endLine（吞并 chunk 前导
 * 空行）或 chunk 无块时 tail 首块的 startLine（让出空行），其文本可能变化。
 * 基线不可用（未建 / 与补丁前块数不对齐）→ 返回 null，调用方退回全量重算。 */
function applyCountPatch(
  p: SegmentPatchRange,
  blocks: PreviewBlock[],
  src: string,
  mode: CountMode
): number | null {
  const bc = blockCounts;
  // 基线对齐的是补丁前的块列表：补丁前块数 = 补丁后块数 - 新增 + 移除
  if (bc === null || bc.length !== blocks.length - p.segAdded + p.segRemoved) {
    return null;
  }
  const lines = splitLines(src);
  // 被替换区间的每个新块按其行界重算（只碰局部 chunk 行，不扫全文）
  const added: number[] = new Array(p.segAdded);
  for (let i = 0; i < p.segAdded; i++) {
    added[i] = countTextAs(blockTextFromLines(lines, blocks[p.segStart + i]), mode);
  }
  bc.splice(p.segStart, p.segRemoved, ...added);
  // 邻接块文本可能被边界调整改变 → 一并重算（成本常数：至多两块）
  const recount = (i: number): void => {
    if (i >= 0 && i < bc.length) {
      bc[i] = countTextAs(blockTextFromLines(lines, blocks[i]), mode);
    }
  };
  recount(p.segStart - 1);
  recount(p.segStart + p.segAdded);
  return totalFromBaseline(bc, mode);
}

/** 切换字数统计口径（主线程设置变更）：
 * 同内容同口径已有缓存 → 直接回执（免重算，块级基线待下次解析惰性重建）；
 * 否则重算（块无缝覆盖时逐块统计建基线）并回填缓存后回执。
 * 与解析回执共用负载形态（Counts），主线程统一落地 counts$。 */
function setCountMode(mode: CountMode): void {
  const switched = mode !== countMode;
  countMode = mode;
  if (!switched && blockCounts !== null) {
    // 重复设置同口径（配置回放等）：直接以当前基线回执，无重算
    post({ type: "counts", mode, value: totalFromBaseline(blockCounts, mode) });
    return;
  }
  const key = cacheKey(contentHash(state.src), mode);
  const cached = countCache.get(key);
  if (cached !== undefined) {
    blockCounts = null; // 基线按新口径待惰性重建（命中回执免重算）
    post({ type: "counts", mode, value: cached });
    return;
  }
  const { value, baseline } = computeCounts(state.src, state.blocks, mode);
  blockCounts = baseline;
  cachePut(key, value);
  post({ type: "counts", mode, value });
}

/** worker 上下文显式收窄（tsconfig 为 DOM lib：Window.postMessage 签名不同，直接用 self 会类型报错） */
interface WorkerCtx {
  postMessage(msg: WorkerOut): void;
  onmessage: ((e: MessageEvent<WorkerIn>) => void) | null;
}
const ctx = self as unknown as WorkerCtx;

function post(msg: WorkerOut): void {
  ctx.postMessage(msg);
}

/* ---------------- 全量结果回传（冷启动 / 强制 / 自愈 / 漂移校正共用） ---------------- */

function postFull(
  rev: number,
  cold: boolean,
  segments: HastSegment[],
  blocks: PreviewBlock[],
  root: MdastRoot,
  src: string
): void {
  const outline = buildOutline(root, blocks);
  // 全量：块级基线整体重建 + 缓存回填（全量统计是口径值的最权威来源，
  // 同哈希|口径的旧缓存条目随之刷新，增量漂移窗口最多存续到下一次全量）
  const { value, baseline } = computeCounts(src, blocks, countMode);
  blockCounts = baseline;
  cachePut(cacheKey(contentHash(src), countMode), value);
  const counts: Counts = { mode: countMode, value };
  // 空文档也必须发首批（items 为空）：主线程以 segStart=0 识别「清空旧列表」，
  // 缺批会让 segments$ 残留上一份文档的段（预览不随清空更新）
  if (segments.length === 0) {
    post({ type: "batch", rev, segStart: 0, items: [], cold });
  }
  for (let i = 0; i < segments.length; i += FULL_BATCH_SEGMENTS) {
    post({ type: "batch", rev, segStart: i, items: segments.slice(i, i + FULL_BATCH_SEGMENTS), cold });
  }
  post({
    type: "result",
    rev,
    full: true,
    totalSegments: segments.length,
    segments: { segStart: 0, segCount: 0, items: [] },
    blocks,
    outline,
    counts,
  });
}

/* ---------------- 例行周期全量（重建 worker 并行执行） ---------------- */

/** 重建 worker 崩溃重连后由主线程换发新 port（同时解除在途标志） */
function attachRebuildPort(port: MessagePort): void {
  rebuildPort = port;
  rebuildInFlight = false;
  port.onmessage = (ev: MessageEvent<RebuildPortOut>) => {
    const msg = ev.data;
    if (!msg || msg.type !== "fullState") return;
    rebuildInFlight = false;
    adoptRebuildState(msg);
  };
  port.start();
}

/** 块列表逐项对比（行界 + 类型）：增量漂移会使两者不一致，需同步主线程 */
function blocksEqual(a: PreviewBlock[], b: PreviewBlock[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.startLine !== y.startLine || x.endLine !== y.endLine || x.type !== y.type) return false;
  }
  return true;
}

/** 采纳重建基线：校验 src 未漂移 → 原子替换旧 HAST；块列表有漂移则同步主线程 */
function adoptRebuildState(msg: Extract<RebuildPortOut, { type: "fullState" }>): void {
  /* 守卫：仅当重建的 src 与当前持有的 src 一致（期间无新编辑、也无冷启动/
     自愈全量换过基线）才采纳，否则丢弃——漂移由下一轮周期重建或 idle 自愈兜住 */
  if (msg.src !== state.src || state.root === null || msg.root === null) return;
  const drifted = !blocksEqual(state.blocks, msg.blocks);
  state.root = msg.root;
  state.hast = msg.hast;
  state.blocks = msg.blocks;
  state.incrementalCount = 0;
  state.lastFullAt = Date.now();
  if (drifted) {
    // 增量启发式误差累积导致块行界漂移：主线程段列表与块列表已错位，
    // 后续补丁 splice 会写错区间 → 必须把校正后的段列表整体回传
    // （例行全量路径：主线程缓冲批次 + result 到达后原子采纳）
    const segments = splitSegments(msg.hast);
    postFull(-1, false, segments, msg.blocks, msg.root, msg.src);
  }
  /* 块列表一致（常态）：静默替换。旧基线树与新基线树内容相同，主线程
     持有的未变段引用继续有效，后续增量补丁正常 splice。 */
}

/** 例行周期全量请求：携带内容哈希，重建 worker 同内容直接复用上次结果 */
function requestRebuild(): void {
  if (!rebuildPort || rebuildInFlight) return; // port 未就绪 / 上轮在途：下一倍数重试
  rebuildInFlight = true;
  const req: RebuildRequestMsg = { type: "fullRequest", src: state.src, hash: contentHash(state.src) };
  rebuildPort.postMessage(req);
}

/* ---------------- 主线程请求处理 ---------------- */

/** 空白文档重置：不解析，把内部状态归零为干净空基线（主线程已直接落地空结果）。
 * root 置 null → 下一次真实解析按冷启动全量走；清掉自愈计时；
 * 在途例行重建若针对旧 src，回包后会被 adoptRebuildState 的 src 不变守卫丢弃。 */
function resetEmpty(): void {
  state.src = "";
  state.root = null;
  state.hast = null;
  state.blocks = [];
  state.incrementalCount = 0;
  state.lastFullAt = 0;
  blockCounts = null; // 块级计数基线随状态归零（内容寻址的 countCache 保留：同内容哈希回传仍正确）
  if (healTimer !== undefined) {
    clearTimeout(healTimer);
    healTimer = undefined;
  }
}

/** 每次解析后重置 idle 自愈计时：有新请求则重新计时（等效「空闲 10s」判定） */
function scheduleHeal(): void {
  if (healTimer !== undefined) clearTimeout(healTimer);
  healTimer = setTimeout(() => {
    healTimer = undefined;
    // 增量块行界未无缝覆盖当前文档 → 强制全量重算（自愈），结果照常回传
    if (!blocksCoverDoc(state.blocks, state.src)) {
      void parse(state.src, true, -1);
    }
  }, HEAL_DELAY_MS);
}

function parse(src: string, forceFull: boolean, rev: number): void {
  /* 冷启动判定必须在推进状态前取：本 worker 实例从未解析过（boot / 崩溃重建后
     的首次解析）→ 全量结果按「冷」回传，主线程清空重建；
     其余全量（idle 自愈 / 空态兜底）为「例行」，主线程原子采纳、不清空已有
     渲染（增量渲染不被打断）。例行周期全量已改由重建 worker 并行执行。 */
  const coldFull = state.root === null;
  const res = buildBlocksIncremental(state, src, forceFull);

  // 推进 worker 状态（结构化克隆只影响回传对象，内部状态始终本线程对象）
  state.src = src;
  state.root = res.root;
  state.hast = res.hast;
  state.blocks = res.blocks;
  state.incrementalCount = res.incrementalCount;
  state.lastFullAt = res.lastFullAt;

  if (res.full) {
    postFull(rev, coldFull, splitSegments(res.hast), res.blocks, res.root, src);
  } else {
    // 增量统计：复用增量解析的输入（补丁区间 + 新块行界）做块级更新，
    // 未变块不重新分段；基线不可用（口径刚切换 / 上轮未建基线 / 不对齐）
    // → 全量重算（结果照常建基线回填缓存）
    const p = res.patch!;
    const patched = applyCountPatch(p, res.blocks, src, countMode);
    let value: number;
    if (patched !== null) {
      value = patched;
    } else {
      const rebuilt = computeCounts(src, res.blocks, countMode);
      blockCounts = rebuilt.baseline;
      value = rebuilt.value;
    }
    cachePut(cacheKey(contentHash(src), countMode), value);
    const segments = splitSegments(res.hast);
    post({
      type: "result",
      rev,
      full: false,
      totalSegments: segments.length,
      segments: {
        segStart: p.segStart,
        segCount: p.segRemoved,
        items: segments.slice(p.segStart, p.segStart + p.segAdded),
      },
      blocks: res.blocks,
      outline: buildOutline(res.root, res.blocks),
      counts: { mode: countMode, value },
    });
    // 例行周期全量：阈值倍数触发（重建 worker 并行执行，不阻塞增量请求）
    if (res.incrementalCount % SELF_HEAL_EVERY === 0) requestRebuild();
  }
  scheduleHeal();
}

ctx.onmessage = (e: MessageEvent<WorkerIn>): void => {
  const msg = e.data;
  if (!msg) return;
  if (msg.type === "initRebuildPort") {
    attachRebuildPort(msg.port);
    return;
  }
  if (msg.type === "setCountMode") {
    // 切换字数统计口径：缓存命中直接回执，未命中重算后回执（见 setCountMode）
    try {
      setCountMode(msg.mode);
    } catch {
      // 统计异常不影响解析链路；下一次解析回执会带上正确口径值
    }
    return;
  }
  if (msg.type === "resetEmpty" || msg.type === "reset") {
    // resetEmpty：空白文档重置；reset：横幅「重新加载」前的全量归零。
    // 两者语义一致：内部状态归零为干净空基线，下一次真实解析冷启动全量
    resetEmpty();
    return;
  }
  if (msg.type !== "parse") return;
  try {
    parse(msg.src, msg.forceFull, msg.rev);
  } catch (err) {
    post({
      type: "error",
      rev: msg.rev,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
