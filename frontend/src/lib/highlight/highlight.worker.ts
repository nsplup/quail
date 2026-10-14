/**
 * 预览代码块着色 worker：highlight.js 解析 + 内存热缓存（仅内存，无持久化）。
 *
 * 【worker 专属模块】由 hl-client.ts 以 module worker 启动；不 import 任何
 * UI 侧模块（仅 contentHash 纯函数），hljs 主包纯 JS、零 DOM 依赖。
 *
 * 缓存设计（权威缓存在 worker，主线程无缓存状态）：
 * - 键 = contentHash(lang + "\0" + code)（内容寻址，复用 lib/worker/contentHash）：
 *   同一代码块编辑 N 次 = N 个不同键、每键恰一条记录，不存在「同块多副本」；
 *   相同内容的不同代码块 / 滚动往返重挂载 / 重开文档全部命中同一条；
 * - 单级内存 LRU（HOT_MAX 条，Map 插入序 = 最近使用序），容量即淘汰，
 *   worker 生命周期结束缓存随之消散；
 * - in-flight 去重：同 hash 并发请求合并为一次解析。
 */
import hljs from "highlight.js";
import { contentHash } from "../worker/contentHash";
import type { HlIn, HlOut, HlSkip, HlRequest } from "./protocol";

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
const HOT_MAX = 64; // 内存缓存条数上限（LRU）
const MAX_CODE_LEN = 256 * 1024; // 超大代码块不着色（toolarge 降级纯文本）

/* ---------------- 内存缓存（LRU，Map 插入序 = 最近使用序） ---------------- */
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
  | { ok: true; html: string; from: "hot" | "parse" }
  | { ok: false; reason: HlSkip["reason"] };

const inflight = new Map<string, Promise<HlOutcome>>();

async function doResolve(lang: string, code: string, hash: string): Promise<HlOutcome> {
  const hotHit = hotGet(hash);
  if (hotHit !== undefined) return { ok: true, html: hotHit, from: "hot" };

  const canonical = ensureLanguage(lang);
  if (canonical === null) return { ok: false, reason: "nolang" };
  let html: string;
  try {
    html = hljs.highlight(code, { language: canonical, ignoreIllegals: true }).value;
  } catch {
    return { ok: false, reason: "error" };
  }
  hotPut(hash, html);
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

/* ---------------- 消息入口 ---------------- */
const postMessage = (msg: HlOut): void =>
  (self as unknown as { postMessage: (m: HlOut) => void }).postMessage(msg);

async function handleHl(msg: HlRequest): Promise<void> {
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
  }
}

self.onmessage = (e: MessageEvent<HlIn>) => {
  const msg = e.data;
  if (!msg) return;
  if (msg.type === "reset") {
    // 内部状态归零（横幅「重新加载」）：热缓存与 in-flight 去重表清空。
    // 已在途的解析协程不受影响，其响应仍会正常回传主线程 pendingReq 表。
    hot.clear();
    inflight.clear();
    return;
  }
  if (msg.type !== "hl") return;
  void handleHl(msg);
};
