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
  countEnglishWords,
  countHanCharacters,
  SELF_HEAL_EVERY,
  type IncrementalParseState,
} from "../markdown/markdown-core";
import type { Root as MdastRoot } from "mdast";
import { contentHash } from "./contentHash";
import type { HastSegment } from "../markdown/markdown-core";
import type { PreviewBlock } from "../types";
import type {
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
  const counts = {
    words: countEnglishWords(src),
    hanChars: countHanCharacters(src),
  };
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
    // 增量：只回传被替换区间的新段（未变段不重发）
    const p = res.patch!;
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
      counts: {
        words: countEnglishWords(src),
        hanChars: countHanCharacters(src),
      },
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
