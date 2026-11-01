/**
 * 引用声明全局 STORE（主线程专属；worker 侧禁止 import——worker 内的
 * 收集与 finalize 在 markdown-core.ts，快照经解析结果消息回传后在此落地）。
 *
 * - refsSnapshot$：唯一事实源，由解析结果落地（setRefsSnapshot / clear），
 *   与段更新同消息、先于段写入 → Svelte 同帧合批，组件渲染期查到的
 *   引用永远与当前段一致（无「新段 + 旧引用」中间态）；
 * - linkDefById$ / footnoteById$：组件查找用派生 Map（O(1)，标识符为
 *   micromark 规范化键，CJK 原样全等匹配）；
 * - footnoteList$：脚注列表项（仅被引用的定义，按首次引用顺序——GFM
 *   编号语义；未引用定义不进列表，与 GitHub 一致）；
 * - 组件渲染的链接 / 引用式图片 href 绕过 HAST sanitize，协议白名单
 *   （sanitizeHref）在组件侧自查防 XSS。
 *
 * 依赖约定：本模块只依赖 svelte/store 与类型（零 worker / DOM 依赖），
 * 可被 MarkdownNode 树任意组件与 stores.ts 安全 import。
 */
import { writable, derived } from "svelte/store";
import type {
  RefsSnapshot,
  LinkDefEntry,
  FootnoteDefEntry,
} from "./markdown-core";

export const EMPTY_REFS: RefsSnapshot = {
  links: [],
  footnotes: [],
  footnoteRefs: [],
};

/** 全局引用快照（唯一事实源；空快照 = 无任何声明） */
export const refsSnapshot$ = writable<RefsSnapshot>(EMPTY_REFS);

/** 落地解析结果携带的快照（undefined = 消息未携带，保持现状） */
export function setRefsSnapshot(snapshot: RefsSnapshot | undefined): void {
  if (snapshot) refsSnapshot$.set(snapshot);
}

/** 清空（空文档 / 文档关闭 / 重置路径，与 segments$ 清空同步） */
export function clearRefsSnapshot(): void {
  refsSnapshot$.set(EMPTY_REFS);
}

/** 链接定义查找表（identifier → 定义） */
export const linkDefById$ = derived(
  refsSnapshot$,
  (s) => new Map<string, LinkDefEntry>(s.links.map((d) => [d.identifier, d])),
);

/** 脚注定义查找表（identifier → 定义） */
export const footnoteById$ = derived(
  refsSnapshot$,
  (s) => new Map<string, FootnoteDefEntry>(s.footnotes.map((d) => [d.identifier, d])),
);

/** 脚注编号查找表（identifier → 编号，首次引用顺序 + 1；未引用 = 无编号） */
export const footnoteNumberById$ = derived(refsSnapshot$, (s) => {
  const m = new Map<string, number>();
  s.footnoteRefs.forEach((r, i) => m.set(r.identifier, i + 1));
  return m;
});

/** 脚注列表项（MarkdownFootnotes 消费：仅被引用的定义，按首现顺序） */
export interface FootnoteListItem {
  /** 脚注编号（首现引用顺序 + 1） */
  number: number;
  identifier: string;
  def: FootnoteDefEntry;
  /** 引用出现次数（回链数量） */
  count: number;
}

export const footnoteList$ = derived(refsSnapshot$, (s) => {
  const byId = new Map(s.footnotes.map((d) => [d.identifier, d]));
  const out: FootnoteListItem[] = [];
  s.footnoteRefs.forEach((r, i) => {
    const def = byId.get(r.identifier);
    if (def) out.push({ number: i + 1, identifier: r.identifier, def, count: r.count });
  });
  return out;
});

/**
 * 链接协议白名单（组件渲染的 href 绕过 HAST sanitize，必须自查）：
 * 允许页内锚（#）、http(s):、mailto: 与无协议相对/绝对路径；
 * 其余（javascript: / data: / vbscript: / file: 等）一律拒绝——
 * 拒绝结果由调用方按「引用不可用」处理（显示字面量，不产生可点链接）。
 */
export function sanitizeHref(url: string): string | null {
  const href = url.trim();
  if (!href) return null;
  if (href.startsWith("#")) return href;
  // 协议形如 scheme:（含 mailto:）；无协议 = 相对/绝对路径，放行
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(href);
  if (!scheme) return href;
  const proto = scheme[1].toLowerCase();
  if (proto === "http" || proto === "https" || proto === "mailto") return href;
  return null;
}
