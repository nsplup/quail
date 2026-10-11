/**
 * Markdown 解析 worker：主线程之外承接完整解析链路
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
 * 职责：
 * - 维护 IncrementalParseState（src/root/hast/blocks），按消息到达顺序串行增量解析；
 * - 全量：段列表分批回传（FullBatch）+ 最终汇总（ParseResult full=true）；
 * - 增量：段级补丁（只回传被替换区间；未变段不重发，保住主线程引用复用）；
 * - 自愈：10s 无新请求时校验 blocksCoverDoc，失败则内部强制全量；
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
  type IncrementalParseState,
} from "../markdown/markdown-core";
import type { WorkerIn, WorkerOut } from "./protocol";

/** 全量段列表的单批段数：控制单条消息体积，同时为渐进渲染提供分批节奏 */
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

/** worker 上下文显式收窄（tsconfig 为 DOM lib：Window.postMessage 签名不同，直接用 self 会类型报错） */
interface WorkerCtx {
  postMessage(msg: WorkerOut): void;
  onmessage: ((e: MessageEvent<WorkerIn>) => void) | null;
}
const ctx = self as unknown as WorkerCtx;

function post(msg: WorkerOut): void {
  ctx.postMessage(msg);
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
     的首次解析）→ 全量结果按「冷」回传，主线程清空重建 + 渐进重放；
     其余全量（25 次增量阈值 / idle 自愈 / 空态兜底）为「例行」，主线程原子
     采纳、不清空已有渲染（增量渲染不被例行全量打断）。 */
  const coldFull = state.root === null;
  const res = buildBlocksIncremental(state, src, forceFull);

  // 推进 worker 状态（结构化克隆只影响回传对象，内部状态始终本线程对象）
  state.src = src;
  state.root = res.root;
  state.hast = res.hast;
  state.blocks = res.blocks;
  state.incrementalCount = res.incrementalCount;

  const segments = splitSegments(res.hast);
  const outline = buildOutline(res.root, res.blocks);
  const counts = {
    words: countEnglishWords(src),
    hanChars: countHanCharacters(src),
  };

  if (res.full) {
    // 全量：分批回传段列表，最后一条 result 汇总（主线程据 full+rev 收口）。
    // 空文档也必须发首批（items 为空）：主线程以 segStart=0 识别「清空旧列表」，
    // 缺批会让 segments$ 残留上一份文档的段（预览不随清空更新）。
    if (segments.length === 0) {
      post({ type: "batch", rev, segStart: 0, items: [], cold: coldFull });
    }
    for (let i = 0; i < segments.length; i += FULL_BATCH_SEGMENTS) {
      post({ type: "batch", rev, segStart: i, items: segments.slice(i, i + FULL_BATCH_SEGMENTS), cold: coldFull });
    }
    post({
      type: "result",
      rev,
      full: true,
      totalSegments: segments.length,
      segments: { segStart: 0, segCount: 0, items: [] },
      blocks: res.blocks,
      outline,
      counts,
    });
  } else {
    // 增量：只回传被替换区间的新段（未变段不重发）
    const p = res.patch!;
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
      outline,
      counts,
    });
  }
  scheduleHeal();
}

ctx.onmessage = (e: MessageEvent<WorkerIn>): void => {
  const msg = e.data;
  if (!msg || msg.type !== "parse") return;
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
